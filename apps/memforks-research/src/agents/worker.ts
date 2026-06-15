import type { ChatOpenAI } from "@langchain/openai";
import type { MemForksCheckpointer } from "@memfork/langgraph";
import { webSearch } from "./tools.js";

export interface WorkerResult {
  findings: string;
}

/**
 * Reusable research worker.
 *
 * Each worker:
 *   1. Recalls prior research on its topic from its dedicated branch.
 *   2. Searches the web (or uses LLM knowledge) for new information.
 *   3. Synthesizes new findings with prior context.
 *   4. Commits the synthesis back to its branch — compounding what's known.
 *
 * Running the same pipeline twice causes the worker to recall its first-run
 * findings and go deeper, rather than starting from scratch.
 */
export async function runWorker(opts: {
  topic:        string;
  threadId:     string;
  checkpointer: MemForksCheckpointer;
  llm:          ChatOpenAI;
}): Promise<string> {
  const { topic, threadId, checkpointer, llm } = opts;
  const branch = `thread/${threadId}`;

  console.log(`\n[Worker ${threadId}] Topic: ${topic}`);

  // ── 1. Recall prior research from this branch ────────────────────────────

  const prior    = await checkpointer.recall(topic, { threadId, limit: 5 });
  const hasPrior = prior.length > 0;

  if (hasPrior) {
    console.log(`[Worker ${threadId}] Recalled ${prior.length} prior finding(s) — building on them.`);
  } else {
    console.log(`[Worker ${threadId}] No prior research found — starting from scratch.`);
  }

  const priorText = prior.map(r => r.text).join("\n\n---\n\n");

  // ── 2. Search / research ──────────────────────────────────────────────────

  const searchQuery = hasPrior
    ? `${topic}\n\nPrior context (go deeper, identify gaps):\n${priorText.slice(0, 800)}`
    : topic;

  const rawFindings = await webSearch(searchQuery, llm);

  // ── 3. Synthesize ─────────────────────────────────────────────────────────

  const synthPrompt = hasPrior
    ? `You are a research synthesizer building on prior work.\n\nPRIOR FINDINGS:\n${priorText}\n\nNEW FINDINGS:\n${rawFindings}\n\nSynthesize into 3-5 numbered key points. Note what is new, what confirms prior findings, and what contradicts them. Be precise.`
    : `Summarize the following research into 3-5 numbered key findings. Be specific and factual.\n\n${rawFindings}`;

  const synthesis = await llm.invoke([
    { role: "system",  content: "You are a precise research synthesizer. Output numbered key findings only." },
    { role: "user",    content: synthPrompt },
  ]);

  const findings = String(synthesis.content);

  // ── 4. Commit to branch ───────────────────────────────────────────────────

  await checkpointer.memforks.commit(branch, {
    facts:   [findings],
    message: `research: ${topic.slice(0, 80)}`,
  });

  console.log(`[Worker ${threadId}] Committed findings to branch ${branch}`);
  console.log(`[Worker ${threadId}] ${findings.split("\n")[0]?.slice(0, 120)}`);

  return findings;
}
