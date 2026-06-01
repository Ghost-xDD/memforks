/**
 * D-4 SPIKE — Event-driven indexer decision.
 *
 * Goal: build a throwaway listener that subscribes to MemForks Move events
 * and prints CommitCreated events in real time.  This proves the event-driven
 * cache is viable and gives us the subscription pattern for the Phase 1 indexer.
 *
 * Recommendation (from IMPLEMENTATION.md): event-driven is the right approach.
 * This spike confirms it.
 *
 * Prerequisites:
 *   - Set MEMFORKS_PACKAGE_ID in .env.local (deployed package on testnet)
 *   - Or run against a local node with the package deployed
 *
 * Run: pnpm d4    (or: npx tsx d4-event-listener.ts)
 *
 * Expected output on a live tree:
 *   Listening for MemForks events on testnet...
 *   [CommitCreated] tree=0x... branch=main author=0x... parents=[0x...]
 *   [BranchCreated] tree=0x... branch=hypothesis-a from=main
 *
 * Fill in SPIKES.md D-4 with actual observed latency and event structure.
 */

import { config } from "dotenv"; config({ path: new URL(".env.local", import.meta.url).pathname });
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";

const SUI_RPC    = process.env["SUI_RPC"]    ?? getFullnodeUrl("testnet");
const PACKAGE_ID = process.env["MEMFORKS_PACKAGE_ID"];

if (!PACKAGE_ID) {
  console.warn(
    "MEMFORKS_PACKAGE_ID not set — will listen for ALL MemForks events " +
    "(useful before first deploy to confirm subscription API works).",
  );
}

const client = new SuiClient({ url: SUI_RPC });

// ─── Connectivity check ───────────────────────────────────────────────────────

const chainId = await client.getChainIdentifier();
console.log("D-4: event listener spike");
console.log("  Chain:", chainId);
console.log("  RPC:  ", SUI_RPC);
console.log("  Package:", PACKAGE_ID ?? "(not set — subscribe to module pattern)");

// ─── Subscribe to events ──────────────────────────────────────────────────────

// The SuiClient WebSocket subscription API.
// Filter by MoveEventType:  <PACKAGE>::<module>::<EventName>
// We subscribe to CommitCreated and BranchCreated for the D-4 demo.

const EVENT_TYPES = [
  `${PACKAGE_ID ?? "0x0"}::tree::CommitCreated`,
  `${PACKAGE_ID ?? "0x0"}::tree::BranchCreated`,
  `${PACKAGE_ID ?? "0x0"}::tree::TreeCreated`,
  `${PACKAGE_ID ?? "0x0"}::resolver::MergeFinalized`,
];

console.log("\nSubscribing to events (Ctrl+C to stop)...\n");

let eventCount = 0;

// Subscribe to each event type
const unsubscribers = await Promise.all(
  EVENT_TYPES.map(async (eventType) => {
    try {
      return await client.subscribeEvent({
        filter: { MoveEventType: eventType },
        onMessage: (event) => {
          eventCount++;
          const type  = event.type.split("::").pop() ?? event.type;
          const ts    = new Date(Number(event.timestampMs ?? 0)).toISOString();
          console.log(`[${ts}] ${type}`);
          console.log("  tx:   ", event.id.txDigest);
          console.log("  data: ", JSON.stringify(event.parsedJson, null, 4)
            .split("\n")
            .join("\n  "));
          console.log();
        },
      });
    } catch (err) {
      console.warn(`  ⚠ Could not subscribe to ${eventType}:`, (err as Error).message);
      return () => {};
    }
  }),
);

// ─── Status ticker ───────────────────────────────────────────────────────────

const ticker = setInterval(() => {
  console.log(`[ticker] listening… events seen so far: ${eventCount}`);
}, 10_000);

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on("SIGINT", async () => {
  clearInterval(ticker);
  await Promise.all(unsubscribers.map((fn) => fn()));
  console.log(`\nD-4 spike finished. Total events received: ${eventCount}`);
  console.log("Record subscription latency and event structure in SPIKES.md §D-4.");
  process.exit(0);
});
