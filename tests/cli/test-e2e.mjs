/**
 * E2E smoke test against Sui testnet.
 *
 * Prerequisites:
 *   1. Run `memfork init` first so ~/.memfork/credentials.json exists, OR
 *   2. Set env vars:
 *        MEMFORK_TREE_ID, MEMFORK_PRIVATE_KEY,
 *        MEMFORK_MEMWAL_ACCOUNT, MEMFORK_MEMWAL_KEY
 *
 * Run: node test-e2e.mjs
 */

import assert from "node:assert/strict";
import { MemForksClient } from "@memfork/core";

// Import config resolver from CLI (resolves from ~/.memfork/credentials.json or env)
const { resolveConfig, toClientConfig } = await import("@memfork/cli");

console.log("\n[MemForks E2E] connecting to Sui testnet…\n");

let cfg;
try {
  cfg = resolveConfig();
} catch (e) {
  console.error("✗ Config not found:", e.message);
  console.error("  Run `memfork init` or set MEMFORK_TREE_ID / MEMFORK_PRIVATE_KEY / MEMFORK_MEMWAL_ACCOUNT / MEMFORK_MEMWAL_KEY");
  process.exit(1);
}

const client = await MemForksClient.connect(toClientConfig(cfg));
console.log("✓ Connected — tree:", cfg.treeId.slice(0, 12) + "…");

// ── 1. getTree ─────────────────────────────────────────────────────────────────
const tree = await client.getTree();
console.log("✓ getTree() — default branch:", tree.default_branch);

// ── 2. getBranchHead ──────────────────────────────────────────────────────────
const branch = String(tree.default_branch);
const head   = await client.getBranchHead(branch);
console.log(`✓ getBranchHead("${branch}") →`, head.slice(0, 12) + "…");

// ── 3. getCommit ──────────────────────────────────────────────────────────────
const commit = await client.getCommit(head);
console.log("✓ getCommit(head) — message:", String(commit.message ?? "(none)").slice(0, 60));

// ── 4. recall (read-only, no MemWal write) ────────────────────────────────────
if (cfg.memwalAccountId && cfg.memwalKey) {
  const results = await client.recall("test recall", { branch, limit: 3 });
  console.log(`✓ recall() — ${results.length} result(s)`);
} else {
  console.log("· recall() skipped (no MemWal credentials)");
}

console.log("\n[MemForks E2E] all checks passed ✓\n");
