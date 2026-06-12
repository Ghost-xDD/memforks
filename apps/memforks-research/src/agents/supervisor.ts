import type { ChatOpenAI } from "@langchain/openai";
import type { MemForksCheckpointer } from "@memfork/langgraph";
import type { AgentState } from "../state.js";
import { runWorker } from "./worker.js";

// ── Plan ──────────────────────────────────────────────────────────────────────

/**
 * Break the research question into two complementary sub-topics
 * that can be researched in parallel.
 */
export async function planNode(
  state: AgentState,
  llm:   ChatOpenAI,
): Promise<Partial<AgentState>> {
  console.log(`\n[Supervisor] Planning: ${state.question}`);

  const res = await llm.invoke([
    {
      role:    "system",
      content: "You are a research planner. Split the question into exactly 2 complementary sub-topics for parallel research. Output ONLY the 2 sub-topics, one per line, no bullets, numbers, or labels.",
    },
    { role: "user", content: state.question },
  ]);

  const lines  = String(res.content).trim().split("\n").map(s => s.trim()).filter(Boolean);
  const topicA = lines[0] ?? `${state.question} — angle A`;
  const topicB = lines[1] ?? `${state.question} — angle B`;

  console.log(`[Supervisor] Stream A: ${topicA}`);
  console.log(`[Supervisor] Stream B: ${topicB}`);

  return { topicA, topicB };
}

// ── Research (parallel workers) ───────────────────────────────────────────────

/**
 * Run both workers in parallel on their dedicated branches.
 * Returns their findings as state updates.
 */
export function makeResearchNode(
  checkpointer: MemForksCheckpointer,
  threadA:      string,
  threadB:      string,
) {
  return async (
    state: AgentState,
    llm:   ChatOpenAI,
  ): Promise<Partial<AgentState>> => {
    console.log("\n[Supervisor] Dispatching workers...");

    const [findingsA, findingsB] = await Promise.all([
      runWorker({ topic: state.topicA, threadId: threadA, checkpointer, llm }),
      runWorker({ topic: state.topicB, threadId: threadB, checkpointer, llm }),
    ]);

    return { findingsA, findingsB };
  };
}

// ── Report ────────────────────────────────────────────────────────────────────

/**
 * Synthesize both worker streams into a final report.
 * Recalls any prior supervisor-level synthesis to build on previous runs.
 * Optionally proposes on-chain merges if a resolver ID is configured.
 */
export function makeReportNode(
  checkpointer: MemForksCheckpointer,
  threadA:      string,
  threadB:      string,
  resolverId:   string | undefined,
) {
  return async (
    state: AgentState,
    llm:   ChatOpenAI,
  ): Promise<Partial<AgentState>> => {
    console.log("\n[Supervisor] Synthesizing final report...");

    // Recall any prior supervisor-level synthesis for this question
    const prior      = await checkpointer.recall(state.question, { threadId: "supervisor", limit: 3 });
    const priorBlock = prior.length > 0
      ? `\nPRIOR SYNTHESIS (build on this, don't repeat):\n${prior.map(r => r.text).join("\n\n")}`
      : "";

    const prompt = [
      `RESEARCH QUESTION: ${state.question}`,
      `\nFINDINGS — STREAM A (${state.topicA}):\n${state.findingsA}`,
      `\nFINDINGS — STREAM B (${state.topicB}):\n${state.findingsB}`,
      priorBlock,
      "\nWrite a structured final report covering:\n1. Key takeaways from each stream\n2. Points of agreement and tension between the streams\n3. Final recommendation or conclusion",
    ].filter(Boolean).join("\n");

    const res = await llm.invoke([
      { role: "system",  content: "You are a senior analyst writing a definitive research report. Be structured, precise, and actionable." },
      { role: "user",    content: prompt },
    ]);

    const report = String(res.content);

    // Commit the supervisor synthesis to its own branch
    await checkpointer.memforks.commit("thread/supervisor", {
      facts:   [`Synthesis — ${state.question}\n\n${report}`],
      message: `report: ${state.question.slice(0, 80)}`,
    });

    // On-chain merge ceremony (if resolver is deployed)
    if (resolverId) {
      console.log("\n[Supervisor] Proposing on-chain merges...");
      await checkpointer.proposeMerge({ fromThread: threadA, intoThread: "supervisor", resolverId });
      await checkpointer.proposeMerge({ fromThread: threadB, intoThread: "supervisor", resolverId });
      console.log("[Supervisor] Merge proposals submitted — resolver will finalize on-chain.");
    } else {
      console.log("\n[Supervisor] Simple merge used (set MEMFORK_RESOLVER_ID for full on-chain ceremony).");
    }

    return { report };
  };
}
