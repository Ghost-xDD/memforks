/**
 * Tests for MemForksClient.history() and materializeAt() — the time-travel layer.
 *
 * These are pure unit tests that operate on synthetic commit payloads; they do
 * not require a live MemWal relayer or Sui node.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PAYLOAD_VERSION } from "../../packages/core/dist/types.js";

// ─── Minimal CommitPayload factory ────────────────────────────────────────────

let blobSeq = 0;
function makePayload({
  branch = "main",
  ts_ms = Date.now(),
  facts = [],
  parent_blob_ids = [],
  parent_blob_hashes = [],
} = {}) {
  const blobId = `blob-${String(++blobSeq).padStart(4, "0")}`;
  const payload = {
    v: PAYLOAD_VERSION,
    type: "commit",
    tree: "dGVzdA==",      // base64("test")
    branch,
    author: "AAAA",
    ts_ms,
    parent_blob_ids,
    parent_blob_hashes,
    delta: { facts },
  };
  return { blobId, text: JSON.stringify(payload) };
}

// ─── Helpers that replicate core client internals ─────────────────────────────

/**
 * Reproduce the topo-sort + BFS logic from MemForksClient.history()
 * so we can test it without instantiating a full client.
 */
function topoSort(rawEntries) {
  const entries = rawEntries.map(({ blobId, text }) => {
    const p = JSON.parse(text);
    return {
      blobId,
      branch: p.branch,
      ts_ms: p.ts_ms,
      parent_blob_ids: p.parent_blob_ids ?? [],
      facts: p.delta?.facts ?? [],
      message: p.delta?.facts?.[0] ?? blobId,
      distance: 0,
    };
  });

  const byBlob = new Map(entries.map((e) => [e.blobId, e]));

  const queue = entries
    .filter((e) => e.parent_blob_ids.every((p) => !byBlob.has(p)))
    .sort((a, b) => a.ts_ms - b.ts_ms);

  const ordered = [];
  const visited = new Set();
  while (queue.length) {
    const e = queue.shift();
    if (visited.has(e.blobId)) continue;
    visited.add(e.blobId);
    ordered.push(e);
    for (const candidate of entries) {
      if (visited.has(candidate.blobId)) continue;
      if (candidate.parent_blob_ids.every((p) => !byBlob.has(p) || visited.has(p))) {
        queue.push(candidate);
      }
    }
    queue.sort((a, b) => a.ts_ms - b.ts_ms);
  }
  for (const e of entries) {
    if (!visited.has(e.blobId)) ordered.push(e);
  }
  return ordered;
}

/**
 * Reproduce materializeAt() logic.
 */
function materializeAt(all, point) {
  if (all.length === 0) return { commits: [], facts: [], cutBlobId: "" };

  let cutIdx = all.length - 1;

  if (point.startsWith("~")) {
    const n = parseInt(point.slice(1), 10);
    if (!isNaN(n)) cutIdx = Math.max(0, all.length - 1 - n);
  } else {
    const prefixMatch = all.findIndex((e) => e.blobId.startsWith(point));
    if (prefixMatch !== -1) {
      cutIdx = prefixMatch;
    } else {
      const ts = isNaN(Number(point)) ? new Date(point).getTime() : Number(point);
      if (!isNaN(ts)) {
        const tsMatch = [...all].reverse().findIndex((e) => e.ts_ms <= ts);
        cutIdx = tsMatch === -1 ? 0 : all.length - 1 - tsMatch;
      }
    }
  }

  const commits = all.slice(0, cutIdx + 1);
  const seen = new Set();
  const facts = [];
  for (const c of commits) {
    for (const f of c.facts) {
      if (!seen.has(f)) { seen.add(f); facts.push(f); }
    }
  }
  return { commits, facts, cutBlobId: all[cutIdx]?.blobId ?? "" };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("topoSort (history reconstruction)", () => {
  test("single commit returns itself", () => {
    const c = makePayload({ facts: ["first fact"], ts_ms: 1000 });
    const sorted = topoSort([c]);
    assert.equal(sorted.length, 1);
    assert.equal(sorted[0].blobId, c.blobId);
  });

  test("linear chain is sorted oldest-first", () => {
    const c1 = makePayload({ ts_ms: 1000, facts: ["a"] });
    const c2 = makePayload({ ts_ms: 2000, facts: ["b"], parent_blob_ids: [c1.blobId] });
    const c3 = makePayload({ ts_ms: 3000, facts: ["c"], parent_blob_ids: [c2.blobId] });

    // Feed in reverse order to prove the sort is topology-driven, not input-order.
    const sorted = topoSort([c3, c1, c2]);
    assert.deepEqual(sorted.map((e) => e.blobId), [c1.blobId, c2.blobId, c3.blobId]);
  });

  test("two independent roots sort by ts_ms", () => {
    const a = makePayload({ ts_ms: 1000, facts: ["root-a"] });
    const b = makePayload({ ts_ms: 500,  facts: ["root-b"] });
    const sorted = topoSort([a, b]);
    assert.equal(sorted[0].blobId, b.blobId); // b has earlier ts_ms
    assert.equal(sorted[1].blobId, a.blobId);
  });

  test("orphaned commits appended after reachable ones", () => {
    const c1 = makePayload({ ts_ms: 1000, facts: ["base"] });
    const c2 = makePayload({
      ts_ms: 2000,
      facts: ["child"],
      parent_blob_ids: ["unknown-parent"],  // parent not in set
    });
    const sorted = topoSort([c1, c2]);
    // Both must be present
    assert.equal(sorted.length, 2);
    const blobs = sorted.map((e) => e.blobId);
    assert.ok(blobs.includes(c1.blobId));
    assert.ok(blobs.includes(c2.blobId));
  });

  test("deduplicates entries with the same blobId", () => {
    const c = makePayload({ facts: ["x"] });
    // Feed the same commit twice (as would happen with duplicate MemWal results).
    const sorted = topoSort([c, { blobId: c.blobId, text: c.text }]);
    assert.equal(sorted.length, 1);
  });
});

describe("materializeAt (time-travel cut points)", () => {
  const BASE_TS = 1_700_000_000_000;

  // Build a 5-commit linear chain — inline so no before() needed.
  blobSeq = 100; // isolate blob IDs from other describe blocks
  const rawChain = [];
  let prev = null;
  for (let i = 0; i < 5; i++) {
    const c = makePayload({
      ts_ms: BASE_TS + i * 60_000,
      facts: [`fact-${i}`],
      parent_blob_ids: prev ? [prev.blobId] : [],
    });
    rawChain.push(c);
    prev = c;
  }
  const chain = topoSort(rawChain);

  test("~0 returns tip only", () => {
    const { commits, facts } = materializeAt(chain, "~0");
    assert.equal(commits.length, 5);
    assert.equal(facts.length, 5);
  });

  test("~1 omits the last commit", () => {
    const { commits, facts } = materializeAt(chain, "~1");
    assert.equal(commits.length, 4);
    assert.deepEqual(facts, ["fact-0","fact-1","fact-2","fact-3"]);
  });

  test("~4 returns only the first commit", () => {
    const { commits, facts } = materializeAt(chain, "~4");
    assert.equal(commits.length, 1);
    assert.deepEqual(facts, ["fact-0"]);
  });

  test("~99 clamps to first commit", () => {
    const { commits } = materializeAt(chain, "~99");
    assert.equal(commits.length, 1);
  });

  test("blob-id prefix match", () => {
    const target = chain[2]; // third commit
    // Use a prefix long enough to be unique within the chain.
    const prefix = target.blobId; // full ID is always a unique prefix of itself
    const { commits, cutBlobId } = materializeAt(chain, prefix);
    assert.equal(cutBlobId, target.blobId);
    assert.equal(commits.length, 3);
  });

  test("Unix-ms timestamp cut", () => {
    const cutTs = BASE_TS + 2 * 60_000; // exactly ts_ms of third commit
    const { commits } = materializeAt(chain, String(cutTs));
    assert.equal(commits.length, 3);
  });

  test("timestamp between commits picks the earlier one", () => {
    const midTs = BASE_TS + 1.5 * 60_000; // halfway between commit 1 and 2
    const { commits } = materializeAt(chain, String(midTs));
    assert.equal(commits.length, 2); // commits 0 and 1
  });

  test("empty chain returns empty result", () => {
    const { commits, facts, cutBlobId } = materializeAt([], "~0");
    assert.equal(commits.length, 0);
    assert.equal(facts.length, 0);
    assert.equal(cutBlobId, "");
  });

  test("facts are deduplicated across commits", () => {
    blobSeq = 200;
    const dup1 = makePayload({ ts_ms: BASE_TS,          facts: ["shared", "unique-a"] });
    const dup2 = makePayload({ ts_ms: BASE_TS + 1000,   facts: ["shared", "unique-b"],
      parent_blob_ids: [dup1.blobId] });
    const sorted = topoSort([dup1, dup2]);
    const { facts } = materializeAt(sorted, "~0");
    assert.deepEqual(facts, ["shared", "unique-a", "unique-b"]);
  });

  test("cutBlobId matches the commit at the cut index", () => {
    const { cutBlobId, commits } = materializeAt(chain, "~2");
    assert.equal(cutBlobId, commits[commits.length - 1].blobId);
  });
});
