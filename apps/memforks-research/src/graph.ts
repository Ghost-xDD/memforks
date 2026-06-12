import { StateGraph, START, END } from "@langchain/langgraph";
import type { ChatOpenAI } from "@langchain/openai";
import type { MemForksCheckpointer } from "@memfork/langgraph";
import { AgentAnnotation } from "./state.js";
import { planNode, makeResearchNode, makeReportNode } from "./agents/supervisor.js";

/**
 * Build the research StateGraph.
 *
 * Graph shape:
 *
 *   START → plan → research → report → END
 *
 * The MemForks checkpointer is attached at compile() time, which means:
 *   - Every node transition is automatically checkpointed to MemWal.
 *   - If the pipeline is killed between nodes, restart with the same
 *     thread_id and LangGraph resumes from the last completed node.
 *
 * The workers inside `research` additionally commit their own findings
 * to their dedicated branches, enabling cross-run compounding memory
 * via recall().
 */
export function buildGraph(opts: {
  checkpointer: MemForksCheckpointer;
  llm:          ChatOpenAI;
  threadA:      string;
  threadB:      string;
  resolverId?:  string;
}) {
  const { checkpointer, llm, threadA, threadB, resolverId } = opts;

  const researchNode = makeResearchNode(checkpointer, threadA, threadB);
  const reportNode   = makeReportNode(checkpointer, threadA, threadB, resolverId);

  return new StateGraph(AgentAnnotation)
    .addNode("plan",     (s) => planNode(s, llm))
    .addNode("research", (s) => researchNode(s, llm))
    .addNode("report",   (s) => reportNode(s, llm))
    .addEdge(START,      "plan")
    .addEdge("plan",     "research")
    .addEdge("research", "report")
    .addEdge("report",   END)
    .compile({ checkpointer });
}
