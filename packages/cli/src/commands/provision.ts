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
 *   addDelegateKey({ packageId, registryId, accountId, publicKey, label, suiPrivateKey, suiClient })
 *
 * We always pass `suiClient` explicitly because the MemWal SDK's internal
 * auto-init may not pick up SuiGrpcClient correctly.
 */

import chalk from "chalk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { confirm } from "@inquirer/prompts";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import {
  createAccount,
  addDelegateKey,
  generateDelegateKey,
} from "@mysten-incubation/memwal/account";
import { MemForksClient, createSuiClient, type SuiGrpcClient, tableIdFromField, addressFieldName, addressFromBcs } from "@memfork/core";
import {
  MEMWAL_CONSTANTS,
} from "../config.js";

function step(n: number, msg: string) {
  process.stdout.write(`  ${chalk.dim(`[${n}/6]`)} ${msg}…  `);
}
function done() { console.log(chalk.green("done")); }
function skip(reason: string) { console.log(chalk.dim("skip  " + reason)); }

// ─── Checkpoint helpers ───────────────────────────────────────────────────────
// Written after each step so a failed init can resume rather than start over.

interface InitCheckpoint {
  network:      "testnet" | "mainnet";
  privateKey?:  string;
  accountId?:   string;
  delegateKey?: string;
  /** MemWal was unavailable — continue with local memory backend. */
  localMemory?: boolean;
}

function checkpointPath(): string {
  return path.join(os.homedir(), ".memfork", ".pending-init.json");
}

function readCheckpoint(): InitCheckpoint | null {
  const p = checkpointPath();
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as InitCheckpoint;
  } catch {
    return null;
  }
}

function saveCheckpoint(data: InitCheckpoint): void {
  const p = checkpointPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function clearCheckpoint(): void {
  try { fs.unlinkSync(checkpointPath()); } catch { /* already gone */ }
}

export interface ProvisionResult {
  treeId:          string;
  privateKey:      string;
  memwalAccountId: string;
  memwalKey:       string;
  network:         "testnet" | "mainnet";
  /** Set when MemWal account/upload path was unavailable and we used local memory. */
  memoryBackend?:  "local" | "memwal";
}

export async function autoProvision(opts: {
  network:        "testnet" | "mainnet";
  existingKey?:   string;
  defaultBranch?: string;
}): Promise<ProvisionResult> {
  const network = opts.network;
  const consts  = MEMWAL_CONSTANTS[network];
  const suiClient = createSuiClient({ network });

  // Load any checkpoint from a previous failed attempt.
  const ckpt = readCheckpoint();
  // If the checkpoint is for a different network, ignore it.
  const cp: InitCheckpoint = (ckpt?.network === network) ? ckpt : { network };

  // ── 1. Keypair ──────────────────────────────────────────────────────────────

  step(1, "Generating Sui keypair");
  let keypair: Ed25519Keypair;

  const resumeKey = opts.existingKey ?? cp.privateKey;
  if (resumeKey) {
    keypair = resumeKey.startsWith("suiprivkey")
      ? Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(resumeKey).secretKey)
      : Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(resumeKey, "hex")));
    skip(cp.privateKey && !opts.existingKey ? "resuming from checkpoint" : "reusing existing key");
  } else {
    keypair = new Ed25519Keypair();
    done();
  }

  const address    = keypair.toSuiAddress();
  const privateKey = keypair.getSecretKey(); // bech32 suiprivkey1…

  console.log(chalk.dim(`      address: ${address}`));

  // Save keypair to checkpoint so a retry can reuse the same key.
  if (!cp.privateKey) {
    cp.privateKey = privateKey;
    saveCheckpoint(cp);
  }

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

  let accountId: string;
  /** When true, skip MemWal on-chain registration and use local memory backend. */
  let useLocalMemory = Boolean(cp.localMemory);

  if (cp.accountId) {
    step(3, "Creating MemWal account on-chain");
    skip("resuming from checkpoint");
    accountId = cp.accountId;
    console.log(chalk.dim(`      accountId: ${accountId}`));
  } else {
    step(3, "Creating MemWal account on-chain");
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
        console.log(chalk.dim("already exists"));
        accountId = await resolveExistingMemwalAccount(
          suiClient,
          consts.registryId,
          address,
        );
        console.log(chalk.dim(`      accountId: ${accountId}`));
      } else if (isMemwalProvisioningBlocked(msg)) {
        console.log(chalk.yellow("unavailable"));
        console.log(
          chalk.dim("      MemWal account creation is paused (security upgrade)."),
        );
        console.log(
          chalk.dim("      Falling back to local memory backend — no MemWal/Walrus needed."),
        );
        useLocalMemory = true;
        // Place the signer's address in the on-chain memwal_account field so
        // init_tree still has a valid address argument. Local recall ignores it.
        accountId = address;
        cp.localMemory = true;
      } else {
        console.log(chalk.red("failed"));
        throw new Error(
          `MemWal account creation failed: ${msg}\n` +
          "  If MemWal is paused, re-run after it reopens, or set memoryBackend to \"local\"\n" +
          "  once you have a tree (see README note).",
        );
      }
    }
    cp.accountId = accountId;
    saveCheckpoint(cp);
  }

  // ── 4 + 5. Delegate key ───────────────────────────────────────────────────────

  let delegatePrivateKey: string;

  if (cp.delegateKey) {
    step(4, "Generating MemWal delegate key");
    skip("resuming from checkpoint");
    step(5, "Registering delegate key with MemWal");
    skip("resuming from checkpoint");
    delegatePrivateKey = cp.delegateKey;
  } else {
    step(4, "Generating MemWal delegate key");
    const delegate = await generateDelegateKey();
    done();
    delegatePrivateKey = delegate.privateKey;

    step(5, "Registering delegate key with MemWal");
    if (useLocalMemory) {
      skip("skipped — local memory mode (no MemWal registration)");
    } else {
      try {
        await addDelegateKey({
          packageId:    consts.packageId,
          registryId:   consts.registryId,
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
        } else if (isMemwalProvisioningBlocked(msg)) {
          console.log(chalk.yellow("unavailable"));
          console.log(
            chalk.dim("      MemWal registration paused — continuing with local memory."),
          );
          useLocalMemory = true;
          cp.localMemory = true;
          saveCheckpoint(cp);
        } else {
          console.log(chalk.red("failed"));
          throw new Error(`Failed to register delegate key: ${msg}`);
        }
      }
    }
    cp.delegateKey = delegatePrivateKey;
    saveCheckpoint(cp);
  }

  // ── 6. MemoryTree ────────────────────────────────────────────────────────────

  step(6, "Creating MemoryTree on Sui");
  const memClient = await MemForksClient.connect({
    treeId:     "", // no tree yet — initTree() creates the object
    signer:     privateKey,
    network,
    packageId:  consts.memforksPackageId,
    ...(sponsorEndpoint ? { sponsorUrl: sponsorEndpoint } : {}),
    ...(useLocalMemory
      ? { memory: { kind: "local" as const } }
      : {
          memwal: {
            accountId,
            delegateKey: delegatePrivateKey,
            serverUrl:   consts.relayer,
          },
        }),
  });

  let treeId: string;
  let digest: string;
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
          "Wait 24 h and run `memfork init --quick` again to resume — your keypair and\n" +
          "MemWal account are already saved and will be reused automatically.",
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
  if (useLocalMemory) {
    console.log(chalk.dim(`      memory: local  (.memfork/local-memory)`));
  }

  // All steps succeeded — clear the checkpoint.
  clearCheckpoint();

  return {
    treeId,
    privateKey,
    memwalAccountId: accountId,
    memwalKey:       delegatePrivateKey,
    network,
    memoryBackend:   useLocalMemory ? "local" : "memwal",
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** MemWal has paused new accounts and/or uploads — treat as soft failure for init. */
function isMemwalProvisioningBlocked(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("timeout") ||
    m.includes("aborted due to timeout") ||
    m.includes("503") ||
    m.includes("paused") ||
    m.includes("disabled") ||
    m.includes("security upgrade") ||
    (m.includes("upload") && m.includes("pause"))
  );
}

/**
 * Resolve a MemWalAccount object ID for `owner` via AccountRegistry.accounts
 * (Table<address, ID>). Accounts are shared objects — listOwnedObjects cannot find them.
 */
async function resolveExistingMemwalAccount(
  suiClient:  SuiGrpcClient,
  registryId: string,
  owner:      string,
): Promise<string> {
  const { object } = await suiClient.getObject({
    objectId: registryId,
    include: { json: true },
  });
  if (!object?.json) {
    throw new Error(`MemWal registry not found: ${registryId}`);
  }
  const accountsTableId = tableIdFromField(
    (object.json as Record<string, unknown>)["accounts"],
  );
  if (!accountsTableId) {
    throw new Error("MemWal registry missing accounts table");
  }

  try {
    const { dynamicField } = await suiClient.getDynamicField({
      parentId: accountsTableId,
      name: addressFieldName(owner),
    });
    return addressFromBcs(dynamicField.value.bcs);
  } catch {
    throw new Error(`Could not find existing MemWal account for ${owner}.`);
  }
}
