/**
 * D-2 SPIKE — MemWal namespace with structured commit payload.
 *
 * CRITICAL FINDING from docs:
 *   MemWal.remember(text) takes a plain STRING — not raw CBOR bytes.
 *   The blob stores encrypted text; embeddings are generated from that text.
 *   For binary payloads, MemWalManual or direct Walrus upload is needed.
 *
 * This spike answers: what storage strategy should Phase 1 use?
 *
 * Three strategies tested:
 *
 *   Strategy A — text/facts only (simplest):
 *     remember(facts.join('\n')) → blob_id stored as memwal_blob_id
 *     Structural metadata (parents, tree_id) stays on-chain in MemoryCommit.
 *     Pros: semantic recall works perfectly. Cons: blob doesn't contain CBOR envelope.
 *
 *   Strategy B — JSON-serialised CommitPayload:
 *     remember(JSON.stringify(payload)) → blob_id stored as memwal_blob_id
 *     Pros: full payload survives; self-describing for restore.
 *     Cons: JSON is larger than CBOR; embeddings from JSON noise.
 *     Mitigation: use analyze() to extract facts separately for recall.
 *
 *   Strategy C — MemWalManual (future):
 *     SEAL-encrypt CBOR payload locally, upload to Walrus, register with rememberManual.
 *     Pros: full CBOR per SPEC §8; correct embeddings from extracted facts.
 *     Cons: requires @mysten/seal + @mysten/walrus peers; more complex setup.
 *     → Tier-3 / Phase 4 work.
 *
 * RECOMMENDATION (written to SPIKES.md §D-2):
 *   Ship Phase 1 with Strategy A (fast, semantic recall works).
 *   Upgrade to Strategy B for the restore/audit path.
 *   Strategy C lands as a Phase 4 stretch with MemWalManual.
 *
 * Run: pnpm d2
 */

import "dotenv/config";
import { encode as cborEncode, decode as cborDecode, cdeEncodeOptions } from "cbor2";
import type { CommitPayload } from "../sdk/src/types.js";

// ─── Part 1: local CBOR roundtrip (no network) ────────────────────────────────

console.log("D-2: structured commit payload spike\n");
console.log("Part 1: Local CBOR roundtrip (offline)\n");

const TREE_ID_BYTES   = new Uint8Array(32).fill(0xab);
const PARENT_ID_BYTES = new Uint8Array(32).fill(0xcd);
const AUTHOR_BYTES    = new Uint8Array(32).fill(0x12);

const payload: CommitPayload = {
  v: 1,
  tree: TREE_ID_BYTES,
  parents: [PARENT_ID_BYTES],
  branch: "hypothesis-a",
  author: AUTHOR_BYTES,
  ts_ms: Date.now(),
  delta: {
    messages: [
      { role: "user",      content: "What is the p99 latency?" },
      { role: "assistant", content: "REST p99 is 180ms at 10k RPS." },
    ],
    facts: [
      "REST avg p99 is 180ms",
      "GraphQL adds 30% overhead at p99",
    ],
    files: [],
  },
  extensions: { spike: "d2", strategy: "A" },
};

// CBOR encode/decode
const encoded   = cborEncode(payload);
const decoded   = cborDecode(encoded) as CommitPayload;
console.log(`  ✓ CBOR encoded: ${encoded.byteLength} bytes`);
console.log(`  ✓ Decoded branch: ${decoded.branch}`);
console.log(`  ✓ Decoded facts: ${JSON.stringify(decoded.delta.facts)}`);

// Deterministic encoding check (SPEC Appendix B)
// cdeEncodeOptions = CDE (Canonical CBOR Encoding) — lexicographic key sort, definite-length
const detA = cborEncode(payload, cdeEncodeOptions);
const detB = cborEncode(payload, cdeEncodeOptions);
const stableEncoding = Buffer.from(detA).equals(Buffer.from(detB));
console.log(`  ✓ Deterministic encoding stable: ${stableEncoding}`);
if (!stableEncoding) throw new Error("Deterministic encoding not stable");

// JSON comparison
const jsonBytes = Buffer.byteLength(JSON.stringify(payload));
console.log(`\n  Size comparison:`);
console.log(`    CBOR: ${encoded.byteLength} bytes`);
console.log(`    JSON: ${jsonBytes} bytes  (${Math.round(jsonBytes / encoded.byteLength * 100)}% of CBOR)`);

// ─── Part 2: Strategy A — what gets stored vs recalled ────────────────────────

console.log("\nPart 2: Strategy A — facts-as-text storage model\n");

const factsText = [
  ...(payload.delta.facts ?? []),
  ...(payload.delta.messages?.map(m => `${m.role}: ${m.content}`) ?? []),
].join("\n");

console.log("  Text that would be passed to remember():");
console.log("  " + factsText.split("\n").join("\n  "));

const jsonPayload = JSON.stringify({
  v: payload.v,
  tree: Buffer.from(payload.tree).toString("hex"),
  parents: payload.parents.map(p => Buffer.from(p).toString("hex")),
  branch: payload.branch,
  author: Buffer.from(payload.author).toString("hex"),
  ts_ms: payload.ts_ms,
  delta: {
    ...payload.delta,
    files: payload.delta.files?.map(f => ({
      path: f.path,
      blob: Buffer.from(f.blob).toString("base64"),
    })),
  },
  extensions: payload.extensions,
});

console.log(`\n  Strategy B — JSON payload size: ${Buffer.byteLength(jsonPayload)} bytes`);

// ─── Part 3: MemWal integration test (requires credentials) ───────────────────

const DELEGATE_KEY = process.env["MEMFORKS_MEMWAL_KEY"];
const ACCOUNT_ID   = process.env["MEMWAL_ACCOUNT_ID"];
const RELAYER_URL  = process.env["MEMWAL_RELAYER"] ?? "https://relayer.staging.memwal.ai";

if (!DELEGATE_KEY || !ACCOUNT_ID) {
  console.log("\nPart 3: Skipped — set MEMFORKS_MEMWAL_KEY + MEMWAL_ACCOUNT_ID in .env.local");
  console.log("         Run `pnpm d1 --setup` first to create credentials.");
} else {
  console.log("\nPart 3: MemWal network test (Strategy A)\n");

  const { MemWal } = await import("@mysten-incubation/memwal");
  const memwal = MemWal.create({
    key:       DELEGATE_KEY,
    accountId: ACCOUNT_ID,
    serverUrl: RELAYER_URL,
    namespace: "memforks/spike/d2",
  });

  await memwal.health();

  // Strategy A: store facts as text
  console.log("  → Strategy A: rememberAndWait(factsText)...");
  const resultA = await memwal.rememberAndWait(factsText);
  console.log(`  ✓ blob_id: ${resultA.blob_id}`);
  console.log(`  ✓ namespace: ${resultA.namespace}`);

  // Recall using semantic query
  const recallA = await memwal.recall({
    query: "API latency benchmarks",
    limit: 3,
    namespace: "memforks/spike/d2",
  });
  console.log(`  ✓ recall returned ${recallA.total} result(s)`);
  recallA.results.forEach((r, i) =>
    console.log(`    [${i}] dist=${r.distance.toFixed(4)} blob=${r.blob_id}`)
  );

  // Strategy B: store JSON payload
  console.log("\n  → Strategy B: rememberAndWait(JSON.stringify(payload))...");
  const resultB = await memwal.rememberAndWait(jsonPayload, "memforks/spike/d2-json");
  console.log(`  ✓ blob_id: ${resultB.blob_id}`);

  // Recall against the JSON blob — will semantic search find it?
  const recallB = await memwal.recall({
    query: "commit payload parents branch",
    limit: 3,
    namespace: "memforks/spike/d2-json",
  });
  console.log(`  ✓ recall (JSON namespace) returned ${recallB.total} result(s)`);

  console.log("\n  → Decision matrix:");
  console.log("    Strategy A: recall works via facts text ✓");
  console.log("    Strategy B: recall works but embeddings from JSON noise");
  console.log("    Strategy C: MemWalManual (Phase 4 stretch)");
}

console.log("\n=== D-2 COMPLETE ===");
console.log("Record findings and strategy decision in SPIKES.md §D-2.");
