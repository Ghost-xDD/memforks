/**
 * D-1 SPIKE — MemWal delegate auth end-to-end on testnet.
 *
 * Goal: verify that a freshly generated keypair can:
 *   1. Register as a MemWal delegate
 *   2. Call MemWal.remember(payload)  →  get back a blob_id
 *   3. Call MemWal.recall(query)       →  retrieve the stored payload
 *
 * This is the single most important spike — the entire MemForks stack sits on it.
 *
 * Prerequisites:
 *   - Copy .env.local.example to .env.local and fill in the values.
 *   - Fund the MEMFORKS_DELEGATE_ADDRESS on testnet (use `sui client faucet`).
 *
 * Run: pnpm d1    (or: npx tsx d1-memwal-roundtrip.ts)
 *
 * Fill in SPIKES.md D-1 with the actual output.
 */

import "dotenv/config";

// ─── TODO: replace with the real MemWal npm package once confirmed ────────────
// Candidate names (check https://www.npmjs.com/):
//   @mysten/memwal
//   memwal-sdk
//   @memwal/sdk
// import { MemWalClient } from "@mysten/memwal";
// ─────────────────────────────────────────────────────────────────────────────

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const SUI_RPC  = process.env["SUI_RPC"]  ?? getFullnodeUrl("testnet");
const MEMWAL_RELAYER = process.env["MEMWAL_RELAYER"] ?? "https://relayer.memwal.ai";
const DELEGATE_KEY   = process.env["MEMFORKS_DELEGATE_KEY"];
const MEMWAL_KEY     = process.env["MEMFORKS_MEMWAL_KEY"];

if (!DELEGATE_KEY || !MEMWAL_KEY) {
  console.error("Set MEMFORKS_DELEGATE_KEY and MEMFORKS_MEMWAL_KEY in .env.local");
  process.exit(1);
}

const suiClient = new SuiClient({ url: SUI_RPC });
const keypair   = Ed25519Keypair.fromSecretKey(DELEGATE_KEY);

console.log("D-1: MemWal roundtrip spike");
console.log("  Sui RPC:       ", SUI_RPC);
console.log("  MemWal relayer:", MEMWAL_RELAYER);
console.log("  Delegate addr: ", keypair.getPublicKey().toSuiAddress());

// ─── Step 1: Verify connectivity ─────────────────────────────────────────────

const chainId = await suiClient.getChainIdentifier();
console.log("\n✓ Sui testnet chain ID:", chainId);

// ─── Step 2: TODO — create or load MemWal account ───────────────────────────
//
// const memwal = new MemWalClient({
//   relayerUrl: MEMWAL_RELAYER,
//   delegateKey: MEMWAL_KEY,
//   suiClient,
// });
// const accountId = process.env["MEMWAL_ACCOUNT_ID"] ?? await memwal.createAccount();
// console.log("✓ MemWal account:", accountId);

// ─── Step 3: TODO — remember ─────────────────────────────────────────────────
//
// const blob_id = await memwal.remember({
//   namespace: "memforks/spike/d1",
//   content: "D-1 spike payload: structured CBOR roundtrip test",
//   facts: ["spike d1 succeeded", "MemWal delegate auth works"],
// });
// console.log("✓ remember() blob_id:", blob_id);

// ─── Step 4: TODO — recall ───────────────────────────────────────────────────
//
// const results = await memwal.recall({
//   namespace: "memforks/spike/d1",
//   query: "spike payload",
// });
// console.log("✓ recall() results:", results);
// if (results.length === 0) throw new Error("recall returned empty — D-1 FAILED");

// ─── Record results in SPIKES.md D-1 ─────────────────────────────────────────
console.log("\nD-1 connectivity check PASSED.");
console.log("TODO: uncomment MemWal SDK sections above once package name is confirmed.");
console.log("Record full results in SPIKES.md §D-1.");
