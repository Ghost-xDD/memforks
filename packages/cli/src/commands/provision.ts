/**
 * Auto-provisioning for `memfork init --quick`.
 *
 * Goes from zero to a fully configured memory tree in one shot:
 *
 *   1. Generate a fresh Ed25519 keypair  (or reuse an existing one)
 *   2. Fund it from the Sui testnet faucet
 *   3. Create a MemWal account on-chain  → accountId
 *   4. Generate a delegate keypair
 *   5. Register the delegate key with MemWal
 *   6. Create a MemoryTree                → treeId
 *
 * Tested against MemWal SDK:
 *   createAccount({ packageId, registryId, suiPrivateKey, suiClient })
 *   generateDelegateKey() → { privateKey: hex, publicKey: Uint8Array, suiAddress }
 *   addDelegateKey({ packageId, accountId, publicKey, suiAddress, label, suiPrivateKey, suiClient })
 *
 * We always pass `suiClient` explicitly because @mysten/sui v2 renames SuiClient
 * to SuiJsonRpcClient, and the MemWal SDK's internal auto-init would fail on v2.
 */

import chalk from "chalk";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { JsonRpcHTTPTransport, SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import {
  createAccount,
  addDelegateKey,
  generateDelegateKey,
} from "@mysten-incubation/memwal/account";
import { MemForksClient } from "@memfork/core";
import {
  MEMWAL_CONSTANTS,
  upsertCredential,
  writeProjectConfig,
} from "../config.js";

function step(n: number, msg: string) {
  process.stdout.write(`  ${chalk.dim(`[${n}/6]`)} ${msg}…  `);
}
function done() { console.log(chalk.green("done")); }
function skip(reason: string) { console.log(chalk.dim("skip  " + reason)); }

export interface ProvisionResult {
  treeId:          string;
  privateKey:      string;
  memwalAccountId: string;
  memwalKey:       string;
  network:         "testnet" | "mainnet";
}

export async function autoProvision(opts: {
  network:        "testnet" | "mainnet";
  existingKey?:   string;
  defaultBranch?: string;
}): Promise<ProvisionResult> {
  const network = opts.network;
  const consts  = MEMWAL_CONSTANTS[network];
  const rpcUrl  = getJsonRpcFullnodeUrl(network);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const suiClient = new SuiJsonRpcClient({ transport: new JsonRpcHTTPTransport({ url: rpcUrl }), network } as any);

  // ── 1. Keypair ──────────────────────────────────────────────────────────────

  step(1, "Generating Sui keypair");
  let keypair: Ed25519Keypair;
  if (opts.existingKey) {
    keypair = opts.existingKey.startsWith("suiprivkey")
      ? Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(opts.existingKey).secretKey)
      : Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(opts.existingKey, "hex")));
    skip("reusing existing key");
  } else {
    keypair = new Ed25519Keypair();
    done();
  }

  const address    = keypair.toSuiAddress();
  const privateKey = keypair.getSecretKey(); // bech32 suiprivkey1…

  console.log(chalk.dim(`      address: ${address}`));

  // ── 2. Faucet (testnet only) ─────────────────────────────────────────────────

  if (network === "testnet") {
    step(2, "Requesting SUI from testnet faucet");
    try {
      const res = await fetch("https://faucet.testnet.sui.io/v1/gas", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ FixedAmountRequest: { recipient: address } }),
        signal:  AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      done();
      // Wait for faucet tx to land before we submit our transactions.
      await new Promise(r => setTimeout(r, 4_000));
    } catch (e) {
      console.log(chalk.yellow("failed"));
      console.log(chalk.yellow(`      ⚠ Faucet error: ${String(e)}`));
      console.log(chalk.yellow(`      Fund manually → https://faucet.testnet.sui.io`));
      console.log(chalk.yellow(`      Address: ${address}`));
      console.log(chalk.yellow(`      Then re-run: memfork init --quick`));
      throw new Error("Faucet unavailable — fund the address above and retry.");
    }
  } else {
    step(2, "Mainnet — faucet not available");
    skip("fund your wallet before re-running");
  }

  // ── 3. MemWal account ────────────────────────────────────────────────────────

  step(3, "Creating MemWal account on-chain");
  let accountId: string;
  try {
    const result = await createAccount({
      packageId:    consts.packageId,
      registryId:   consts.registryId,
      suiPrivateKey: privateKey,
      suiClient,
    });
    accountId = result.accountId;
    done();
    console.log(chalk.dim(`      accountId: ${accountId}`));
  } catch (e) {
    const msg = String(e);
    if (msg.includes("EAccountAlreadyExists") || msg.includes("MoveAbort") && msg.includes(", 3)")) {
      // Error code 3 = EAccountAlreadyExists — fine, just fetch the existing one.
      console.log(chalk.dim("already exists"));
      accountId = await resolveExistingMemwalAccount(suiClient, consts.packageId, address);
      console.log(chalk.dim(`      accountId: ${accountId}`));
    } else {
      console.log(chalk.red("failed"));
      throw new Error(`MemWal account creation failed: ${msg}`);
    }
  }

  // ── 4 + 5. Delegate key ───────────────────────────────────────────────────────

  step(4, "Generating MemWal delegate key");
  const delegate = await generateDelegateKey();
  done();

  step(5, "Registering delegate key with MemWal");
  try {
    await addDelegateKey({
      packageId:    consts.packageId,
      accountId,
      publicKey:    delegate.publicKey,
      label:        `memfork-cli-${new Date().toISOString().slice(0, 10)}`,
      suiPrivateKey: privateKey,
      suiClient,
    });
    done();
  } catch (e) {
    const msg = String(e);
    if (msg.includes("EDelegateKeyAlreadyExists") || msg.includes("MoveAbort") && msg.includes(", 0)")) {
      skip("key already registered");
    } else {
      console.log(chalk.red("failed"));
      throw new Error(`Failed to register delegate key: ${msg}`);
    }
  }

  // ── 6. MemoryTree ────────────────────────────────────────────────────────────

  step(6, "Creating MemoryTree on Sui");
  const memClient = await MemForksClient.connect({
    treeId:  "0x" + "0".repeat(64), // placeholder — initTree creates the object
    signer:  privateKey,
    network,
    memwal: {
      accountId,
      delegateKey: delegate.privateKey,
      serverUrl:   consts.relayer,
    },
  });

  const { treeId, digest } = await memClient.initTree(
    accountId,
    opts.defaultBranch ?? "main",
  );
  done();
  console.log(chalk.dim(`      treeId: ${treeId}`));
  console.log(chalk.dim(`      tx:     ${digest}`));

  return {
    treeId,
    privateKey,
    memwalAccountId: accountId,
    memwalKey:       delegate.privateKey,
    network,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveExistingMemwalAccount(
  suiClient: SuiJsonRpcClient,
  packageId:  string,
  owner:      string,
): Promise<string> {
  const objs = await suiClient.getOwnedObjects({
    owner,
    filter: { StructType: `${packageId}::account::MemWalAccount` },
    options: { showContent: false },
  });
  const first = objs.data?.[0];
  if (!first?.data?.objectId) {
    throw new Error("Could not find existing MemWal account for this address.");
  }
  return first.data.objectId;
}
