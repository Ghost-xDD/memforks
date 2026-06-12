/**
 * MemForks Research Pipeline
 *
 * Usage:
 *   npm run research "<question>"          # uses stable branch IDs → compounding memory
 *   npm run research "<question>" --fresh  # new branch IDs per run → always starts fresh
 *
 * What happens:
 *   1. Supervisor breaks the question into two sub-topics.
 *   2. Two workers research in parallel on separate MemForks branches.
 *      Each worker recalls prior findings from its branch before searching,
 *      so the second run builds on the first (compounding knowledge).
 *   3. Supervisor synthesizes both streams into a final report, also recalling
 *      any prior supervisor-level synthesis.
 *   4. All findings are committed to MemForks on-chain. Next run builds on this.
 */

import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { createMemForksCheckpointer } from "@memfork/langgraph";
import { buildGraph } from "./graph.js";

// ─── Args ─────────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2);
const fresh    = args.includes("--fresh");
const question = args.filter(a => !a.startsWith("--")).join(" ").trim();

if (!question) {
  console.error('Usage: npm run research "<question>" [--fresh]');
  process.exit(1);
}

// ─── Setup ────────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(60));
console.log("  MemForks Research Pipeline");
console.log("═".repeat(60));
console.log(`  Question : ${question}`);
console.log(`  Mode     : ${fresh ? "fresh (new branches)" : "compounding (builds on prior runs)"}`);
console.log("═".repeat(60));

const llm = new ChatOpenAI({
  model:       process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  temperature: 0.3,
});

const checkpointer = await createMemForksCheckpointer({
  network:    (process.env.MEMFORK_NETWORK ?? "testnet") as "testnet" | "mainnet",
  sponsorUrl: process.env.MEMFORK_SPONSOR_URL,
});

// ─── Branch setup ─────────────────────────────────────────────────────────────

// Stable thread IDs → same branches across runs (compounding memory).
// --fresh appends a timestamp to create brand-new branches.
const suffix  = fresh ? `-${Date.now()}` : "";
const threadA = `research-a${suffix}`;
const threadB = `research-b${suffix}`;

const client   = checkpointer.memforks;
const tree     = await client.getTree();
const existing = new Set(Object.keys(tree.branches as Record<string, string>));

for (const branch of [`thread/${threadA}`, `thread/${threadB}`, "thread/supervisor"]) {
  if (!existing.has(branch)) {
    console.log(`\n[setup] Creating branch: ${branch}`);
    await client.branch(branch, { from: "main" });
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

const graph = buildGraph({
  checkpointer,
  llm,
  threadA,
  threadB,
  resolverId: process.env.MEMFORK_RESOLVER_ID,
});

// The supervisor thread_id is used for the main graph's checkpointing.
// Kill and restart with the same question → the graph resumes from where it stopped.
const config = { configurable: { thread_id: `supervisor${suffix}` } };
const result = await graph.invoke({ question }, config);

// ─── Output ───────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(60));
console.log("  FINAL REPORT");
console.log("═".repeat(60));
console.log(result.report);
console.log("═".repeat(60));
console.log(`\nAll findings committed to MemForks (network: ${process.env.MEMFORK_NETWORK ?? "testnet"}).`);
console.log("Run the same question again to build on these findings.\n");
