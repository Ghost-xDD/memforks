/**
 * D-2 SPIKE — MemWal namespace with arbitrary CBOR payload.
 *
 * Goal: confirm that a MemWal memory entry can carry a structured CBOR blob
 * containing { v, tree, parents, branch, author, ts_ms, delta, extensions }
 * as specified in SPEC §8, so one blob carries parent CIDs + delta.
 *
 * This validates that we don't need a separate "envelope" storage layer.
 *
 * Run: pnpm d2    (or: npx tsx d2-cbor-payload.ts)
 *
 * Fill in SPIKES.md D-2 with the actual output.
 */

import "dotenv/config";
import { encode, decode } from "cbor2";
import type { CommitPayload } from "../sdk/src/types.js";

// ─── Build a sample CommitPayload and round-trip through CBOR ────────────────

const TREE_ID_BYTES   = new Uint8Array(32).fill(0xab); // fake 32-byte ID
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
  extensions: { spike: "d2" },
};

console.log("D-2: CBOR payload roundtrip spike");
console.log("  Payload (pre-encode):", JSON.stringify({
  ...payload,
  tree: `<${payload.tree.length} bytes>`,
  parents: payload.parents.map(p => `<${p.length} bytes>`),
  author: `<${payload.author.length} bytes>`,
}, null, 2));

// ─── Encode ──────────────────────────────────────────────────────────────────

const encoded = encode(payload);
console.log(`\n✓ CBOR encoded: ${encoded.byteLength} bytes`);

// ─── Decode ──────────────────────────────────────────────────────────────────

const decoded = decode(encoded) as CommitPayload;
console.log("✓ CBOR decoded:", {
  v: decoded.v,
  branch: decoded.branch,
  facts: decoded.delta.facts,
  parentCount: decoded.parents.length,
});

// ─── Verify structural integrity ─────────────────────────────────────────────

if (decoded.v !== 1) throw new Error("version field lost");
if (decoded.branch !== payload.branch) throw new Error("branch field lost");
if (!decoded.delta.facts?.includes("REST avg p99 is 180ms")) throw new Error("facts lost");
if (decoded.parents.length !== 1) throw new Error("parent count wrong");

console.log("\n✓ All fields survived CBOR roundtrip.");

// ─── Deterministic encoding check (SPEC Appendix B) ──────────────────────────
// SPEC requires deterministic CBOR (lexicographic key order, definite-length).
// cbor2 supports deterministic mode — test it here.

const deterministicA = encode(payload, { sortKeys: true });
const deterministicB = encode(payload, { sortKeys: true });
const match = Buffer.from(deterministicA).equals(Buffer.from(deterministicB));
console.log(`✓ Deterministic encoding stable: ${match}`);
if (!match) throw new Error("Deterministic encoding not stable — D-2 FAILED");

// ─── TODO: send to MemWal relayer and confirm it accepts the payload ──────────
//
// const memwal = new MemWalClient({ ... });
// const blob_id = await memwal.remember({
//   namespace: "memforks/spike/d2",
//   content: Buffer.from(encoded),   // raw CBOR bytes as content
//   contentType: "application/cbor",
// });
// console.log("✓ MemWal accepted CBOR payload, blob_id:", blob_id);

console.log("\nD-2 local CBOR roundtrip PASSED.");
console.log("TODO: uncomment MemWal section above to confirm relayer accepts raw CBOR.");
console.log("Record results in SPIKES.md §D-2.");
