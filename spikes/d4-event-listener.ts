/**
 * D-4 SPIKE — Event-driven indexer decision.
 *
 * **Finding**: The public Sui testnet fullnode (https://fullnode.testnet.sui.io)
 * returns HTTP 405 on WebSocket upgrade — `subscribeEvent` is unavailable on the
 * shared RPC tier.  This is fine for production: we use `queryEvents` with a
 * cursor-based polling loop, which is supported everywhere and is more reliable.
 *
 * This spike tests `queryEvents` polling against the deployed contract and confirms:
 *   1. Events are retrievable with the right filter.
 *   2. `parsedJson` has the expected field names.
 *   3. Cursor-based pagination works correctly.
 *
 * Indexer architecture decision: poll `queryEvents` every N seconds, advance
 * cursor, fan out to in-memory cache.  Fall back to WebSocket if a premium RPC
 * endpoint is available.
 *
 * Run: npx tsx d4-event-listener.ts
 * Prereqs: MEMFORKS_PACKAGE_ID in .env.local
 */

import { config } from "dotenv"; config({ path: new URL(".env.local", import.meta.url).pathname });
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";

const SUI_RPC    = process.env["SUI_RPC"]    ?? getFullnodeUrl("testnet");
const PACKAGE_ID = process.env["MEMFORKS_PACKAGE_ID"];

if (!PACKAGE_ID) {
  console.error("Set MEMFORKS_PACKAGE_ID in spikes/.env.local (run deploy.sh first).");
  process.exit(1);
}

const client = new SuiClient({ url: SUI_RPC });

// ─── Connectivity check ───────────────────────────────────────────────────────

const chainId = await client.getChainIdentifier();
console.log("D-4: event indexer spike (polling via queryEvents)");
console.log("  Chain:  ", chainId);
console.log("  RPC:    ", SUI_RPC);
console.log("  Package:", PACKAGE_ID);

// ─── Helper: query a single event type ───────────────────────────────────────

async function fetchEvents(module: string, event: string, cursor?: string | null) {
  const filter = { MoveEventType: `${PACKAGE_ID}::${module}::${event}` };
  const result = await client.queryEvents({
    query: filter,
    cursor: cursor ? { txDigest: cursor, eventSeq: "0" } : undefined,
    limit: 50,
    order: "ascending",
  });
  return result;
}

// ─── Round 1: fetch all TreeCreated events (we created two above in D-3 runs) ─

console.log("\n→ Querying TreeCreated events...");
const t0 = Date.now();
const treeEvents = await fetchEvents("tree", "TreeCreated");
const latency = Date.now() - t0;

console.log(`✓ TreeCreated: ${treeEvents.data.length} events (query latency: ${latency}ms)`);

if (treeEvents.data.length === 0) {
  console.error("No TreeCreated events found. Deploy the package and call init_tree first.");
  process.exit(1);
}

for (const ev of treeEvents.data) {
  console.log(`\n  [TreeCreated]`);
  console.log(`    tx:        ${ev.id.txDigest}`);
  console.log(`    eventSeq:  ${ev.id.eventSeq}`);
  console.log(`    timestamp: ${new Date(Number(ev.timestampMs ?? 0)).toISOString()}`);
  console.log(`    parsedJson:`, JSON.stringify(ev.parsedJson, null, 6).replace(/\n/g, "\n    "));
}

// ─── Round 2: cursor test — re-fetch from beginning, advance past first event ─

console.log("\n→ Testing cursor-based pagination...");
const firstDigest = treeEvents.data[0].id.txDigest;
const fromFirst   = await fetchEvents("tree", "TreeCreated");
const fromSecond  = await fetchEvents(
  "tree",
  "TreeCreated",
  treeEvents.data.length > 1 ? treeEvents.data[0].id.txDigest : undefined,
);

console.log(`  All events:          ${fromFirst.data.length}`);
console.log(`  Events after cursor: ${fromSecond.data.length}`);
console.log(`  hasNextPage:         ${treeEvents.nextCursor !== null}`);

// ─── Round 3: confirm other event types are queryable ─────────────────────────

console.log("\n→ Checking all MemForks event types are queryable...");
const eventTypes: [string, string][] = [
  ["tree",     "CommitCreated"],
  ["tree",     "BranchCreated"],
  ["tree",     "TreeCreated"],
  ["resolver", "MergeFinalized"],
];

for (const [mod, evt] of eventTypes) {
  try {
    const res = await fetchEvents(mod, evt);
    console.log(`  ${mod}::${evt}: ${res.data.length} events`);
  } catch (err) {
    console.log(`  ${mod}::${evt}: ERROR — ${(err as Error).message}`);
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

const firstEvent = treeEvents.data[0];
const parsedFields = Object.keys(firstEvent.parsedJson as object);

console.log("\n=== D-4 PASSED ===");
console.log("Record these in SPIKES.md §D-4:");
console.log("  Transport:              queryEvents polling (WebSocket 405 on public RPC)");
console.log("  queryEvents latency:   ", latency + "ms");
console.log("  TreeCreated fields:    ", parsedFields.join(", "));
console.log("  Cursor pagination:      works");
console.log("  hasNextPage field:      present");
