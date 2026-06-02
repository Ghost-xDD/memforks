/**
 * @memfork/langgraph — LangGraph checkpointer adapter for MemForks.
 *
 * Usage:
 *   import { createMemForksCheckpointer } from "@memfork/langgraph";
 *   import { StateGraph } from "@langchain/langgraph";
 *
 *   const checkpointer = await createMemForksCheckpointer({
 *     treeId:    process.env.MEMFORK_TREE_ID!,
 *     signer:    process.env.MEMFORK_PRIVATE_KEY!,
 *     memwal: {
 *       accountId:  process.env.MEMFORK_MEMWAL_ACCOUNT!,
 *       delegateKey: process.env.MEMFORK_MEMWAL_KEY!,
 *     },
 *     branch: "dev/my-agent",
 *   });
 *
 *   const app = new StateGraph(...)
 *     .compile({ checkpointer });
 */

export { MemForksCheckpointer, createMemForksCheckpointer } from "./checkpointer.js";
export type { MemForksCheckpointerConfig } from "./checkpointer.js";
