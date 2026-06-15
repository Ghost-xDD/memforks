/**
 * Auto-provisioning for `memfork init --quick`.
 *
 * Goes from zero to a fully configured memory tree in one shot:
 *
 *   1. Generate a fresh Ed25519 keypair  (or reuse an existing one)
 *   2. Display faucet link — user funds the wallet manually (testnet)
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
import { confirm } from "@inquirer/prompts";
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

  // ── 2. Fund wallet ───────────────────────────────────────────────────────────

  // sponsorBase  = root URL, used for /drip and /sponsor paths.
  // sponsorEndpoint = full URL the MemForksClient POSTs to (no path appended internally).
  let sponsorBase: string | undefined;
  let sponsorEndpoint: string | undefined;

  if (network === "testnet") {
    console.log(`  ${chalk.dim("[2/6]")} Fund your testnet wallet`);
    console.log();
    console.log(`        ${chalk.bold("Address:")} ${address}`);
    console.log(`        ${chalk.bold("Faucet: ")} ${chalk.cyan("https://faucet.testnet.sui.io")}`);
    console.log();
    await confirm({
      message: "Press Enter once your wallet has been funded",
      default: true,
    });
  } else {
    // Mainnet: drip covers the two MemWal calls (createAccount + addDelegateKey).
    // initTree (step 6) goes through /sponsor — the MemForksClient handles that path.
    step(2, "Requesting mainnet gas from MemForks sponsor");
    // Normalise: strip a trailing /sponsor so the base URL is always path-free.
    sponsorBase = (process.env.MEMFORK_SPONSOR_URL ?? "https://memforks-sponsor-production.up.railway.app")
      .replace(/\/sponsor\/?$/, "");
    sponsorEndpoint = `${sponsorBase}/sponsor`;
    try {
      const res = await fetch(`${sponsorBase}/drip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const data = await res.json() as {
        digest?: string;
        amount?: number;
        skipped?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      if (data.skipped) {
        skip("address already has gas");
      } else {
        done();
        console.log(chalk.dim(`      drip tx:  ${data.digest}`));
        console.log(chalk.dim(`      amount:   ${((data.amount ?? 0) / 1_000_000_000).toFixed(3)} SUI`));
      }
    } catch (e) {
      console.log(chalk.red("failed"));
      throw new Error(
        `Could not get gas from sponsor (${sponsorBase}/drip): ${String(e)}\n` +
        `  Fund the address manually then re-run:\n` +
        `    ${address}`,
      );
    }
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
    treeId:     "", // no tree yet — initTree() creates the object
    signer:     privateKey,
    network,
    packageId:  consts.memforksPackageId,
    // sponsorEndpoint is the full POST URL — MemForksClient appends no path.
    ...(sponsorEndpoint ? { sponsorUrl: sponsorEndpoint } : {}),
    memwal: {
      accountId,
      delegateKey: delegate.privateKey,
      serverUrl:   consts.relayer,
    },
  });

  let treeId: string;
  let digest: string;
  // Retry once on a transient gas-coin version race: the sponsor refreshes its
  // pool after the drip, but if initTree lands before that completes the
  // fullnode may report a stale-object error. A short wait + retry clears it.
  const maxAttempts = 2;
  for (let attempt = 1; ; attempt++) {
    try {
      ({ treeId, digest } = await memClient.initTree(
        accountId,
        opts.defaultBranch ?? "main",
      ));
      break;
    } catch (e) {
      const msg = String(e);
      const isTransient =
        msg.includes("needs to be rebuilt") ||
        msg.includes("unavailable for consumption") ||
        msg.includes("object version");

      if (isTransient && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }

      console.log(chalk.red("failed"));
      if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) {
        throw new Error(
          "Sponsor rate limit hit for init_tree (1/IP/day).\n" +
          "Wait 24 h and run `memfork init --quick` again, or fund the wallet manually:\n" +
          `  ${address}`,
        );
      }
      if (msg.includes("Sponsor error: 404")) {
        throw new Error(
          `Sponsor endpoint not reachable (${sponsorEndpoint}).\n` +
          "Set MEMFORK_SPONSOR_URL to your sponsor base URL and retry.",
        );
      }
      throw new Error(`MemoryTree creation failed: ${msg}`);
    }
  }

  if (!treeId) {
    throw new Error("MemoryTree creation returned no treeId — check sponsor logs.");
  }

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
