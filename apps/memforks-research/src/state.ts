import { Annotation } from "@langchain/langgraph";

export const AgentAnnotation = Annotation.Root({
  question:  Annotation<string>(),
  topicA:    Annotation<string>({ default: () => "", reducer: (_, b) => b }),
  topicB:    Annotation<string>({ default: () => "", reducer: (_, b) => b }),
  findingsA: Annotation<string>({ default: () => "", reducer: (_, b) => b }),
  findingsB: Annotation<string>({ default: () => "", reducer: (_, b) => b }),
  report:    Annotation<string>({ default: () => "", reducer: (_, b) => b }),
});

export type AgentState = typeof AgentAnnotation.State;
