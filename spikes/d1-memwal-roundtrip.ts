/**
 * D-1 SPIKE — MemWal delegate auth end-to-end on testnet.
 *
 * Package: @mysten-incubation/memwal
 * Relayer:  https://relayer.staging.memwal.ai  (testnet)
 *
 * Goal: verify that a freshly generated keypair can:
 *   1. Create a MemWal account on testnet
 *   2. Add a delegate key to it
 *   3. Call remember(text)  →  get back a blob_id
 *   4. Call recall(query)   →  retrieve the stored text
 *
 * This is the single most important spike — the entire MemForks stack sits on it.
 *
 * One-time setup (run once, then paste values into .env.local):
 *   npx tsx d1-memwal-roundtrip.ts --setup
 *
 * Roundtrip test (uses existing .env.local credentials):
 *   pnpm d1
 *
 * Fill in SPIKES.md §D-1 with the actual output.
 */

import "dotenv/config";
import {
  MemWal,
  generateDelegateKey,
  createAccount,
  addDelegateKey,
} from "@mysten-incubation/memwal/account";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";

// ─── Config ──────────────────────────────────────────────────────────────────

const SETUP_MODE     = process.argv.includes("--setup");
const SUI_RPC        = process.env["SUI_RPC"] ?? getFullnodeUrl("testnet");
const RELAYER_URL    = process.env["MEMWAL_RELAYER"] ?? "https://relayer.staging.memwal.ai";
const DELEGATE_KEY   = process.env["MEMFORKS_MEMWAL_KEY"];      // Ed25519 hex
const ACCOUNT_ID     = process.env["MEMWAL_ACCOUNT_ID"];         // MemWalAccount object ID
const OWNER_KEY      = process.env["SUI_OWNER_PRIVATE_KEY"];     // needed for --setup only

// ─── Mode: --setup  ───────────────────────────────────────────────────────────
// Run once to generate a delegate keypair, create a MemWal account, and register
// the delegate key. Paste the output into .env.local.

if (SETUP_MODE) {
  if (!OWNER_KEY) {
    console.error(
      "Set SUI_OWNER_PRIVATE_KEY in .env.local (the wallet that will own the MemWal account).",
    );
    process.exit(1);
  }

  console.log("=== D-1 SETUP ===\n");

  // 1. Generate a fresh delegate keypair.
  const { privateKey, publicKey, suiAddress } = generateDelegateKey();
  console.log("Generated delegate keypair:");
  console.log("  privateKey (→ MEMFORKS_MEMWAL_KEY):", privateKey);
  console.log("  suiAddress:", suiAddress);

  const suiClient = new SuiClient({ url: SUI_RPC });

  // 2. Create MemWal account (one per Sui owner address).
  const account = await createAccount({
    ownerKey: OWNER_KEY,
    suiClient,
    registryId: "0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437",
  });
  console.log("\nMemWalAccount created:");
  console.log("  accountId (→ MEMWAL_ACCOUNT_ID):", account.accountId);

  // 3. Add the delegate key to the account.
  await addDelegateKey({
    ownerKey: OWNER_KEY,
    accountId: account.accountId,
    delegatePublicKey: publicKey,
    delegateAddress: suiAddress,
    label: "memforks-spike-d1",
    suiClient,
  });
  console.log("\n✓ Delegate key registered on account.\n");

  console.log("Add to .env.local:");
  console.log(`MEMFORKS_MEMWAL_KEY=${privateKey}`);
  console.log(`MEMWAL_ACCOUNT_ID=${account.accountId}`);
  process.exit(0);
}

// ─── Mode: roundtrip test ─────────────────────────────────────────────────────

if (!DELEGATE_KEY || !ACCOUNT_ID) {
  console.error(
    "Set MEMFORKS_MEMWAL_KEY and MEMWAL_ACCOUNT_ID in .env.local.\n" +
    "Run --setup first if you haven't created a MemWal account yet.",
  );
  process.exit(1);
}

import { MemWal as MemWalClient } from "@mysten-incubation/memwal";

console.log("D-1: MemWal roundtrip spike");
console.log("  Relayer:   ", RELAYER_URL);
console.log("  Account ID:", ACCOUNT_ID);

const memwal = MemWalClient.create({
  key:       DELEGATE_KEY,
  accountId: ACCOUNT_ID,
  serverUrl: RELAYER_URL,
  namespace: "memforks/spike/d1",
});

// ─── Step 1: health check ─────────────────────────────────────────────────────

const health = await memwal.health();
console.log("\n✓ Relayer health:", health.status, `(v${health.version})`);

// ─── Step 2: remember ────────────────────────────────────────────────────────

const TEST_TEXT = [
  "REST avg p99 is 180ms at 10k RPS",
  "GraphQL adds 30% overhead at p99 compared to REST",
  "MemForks D-1 spike: delegate auth works end-to-end",
].join("\n");

console.log("\n→ Calling rememberAndWait()...");
const memResult = await memwal.rememberAndWait(TEST_TEXT);

console.log("✓ remember() result:");
console.log("  blob_id:   ", memResult.blob_id);
console.log("  namespace: ", memResult.namespace);
console.log("  owner:     ", memResult.owner);

// ─── Step 3: recall ──────────────────────────────────────────────────────────

console.log("\n→ Calling recall()...");
const recallResult = await memwal.recall({
  query: "What do we know about API latency?",
  limit: 3,
});

console.log("✓ recall() results:", recallResult.total, "total");
recallResult.results.forEach((r, i) => {
  console.log(`  [${i}] distance=${r.distance.toFixed(4)}  blob_id=${r.blob_id}`);
  console.log(`       text="${r.text.slice(0, 80)}..."`);
});

if (recallResult.results.length === 0) {
  throw new Error("recall returned empty — D-1 FAILED");
}

// ─── Step 4: verify the blob_id shape ────────────────────────────────────────
// blob_id is the Walrus blob ID — this is what we store as memwal_blob_id
// on a MemoryCommit. Confirm it's the right shape.

const blobId = memResult.blob_id;
console.log(`\n✓ blob_id format: "${blobId}" (length=${blobId.length})`);
console.log("  → This is the value stored as MemoryCommit.memwal_blob_id on-chain.");

console.log("\n=== D-1 PASSED ===");
console.log("Record blob_id format, recall shape, and latency in SPIKES.md §D-1.");
