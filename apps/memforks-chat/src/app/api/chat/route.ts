import { openai } from "@ai-sdk/openai";
import { withMemForks } from "@memfork/vercel-ai";
import { streamText, type Message } from "ai";
import { formatRecalledContext, recallFacts } from "@/lib/memfork";

export const maxDuration = 60;

interface ChatRequest {
  messages: Message[];
  branch?: string;
}

export async function POST(req: Request) {
  const { messages, branch = "main" } = (await req.json()) as ChatRequest;

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const query =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : branch;

  const recalled = await recallFacts(query, branch).catch((err) => {
    console.error("[memfork] recall failed:", err);
    return [];
  });
  const recalledContext = formatRecalledContext(branch, recalled);

  const model = withMemForks(openai("gpt-4o-mini"), {
    branch,
    recallLimit: 0,
    autoCommit: true,
  });

  const systemParts: string[] = [
    "You are a helpful assistant with persistent memory via MemForks. " +
      "When the user shares facts about themselves (name, project, preferences, decisions), " +
      "acknowledge and restate them explicitly in your reply so they are captured in memory. " +
      "Facts recalled from prior sessions are provided below — treat them as established context " +
      "and reference them naturally without hedging.",
  ];
  if (recalledContext) systemParts.push(recalledContext);

  const result = streamText({
    model,
    messages,
    system: systemParts.join("\n\n"),
    experimental_generateMessageId: () => crypto.randomUUID(),
  });

  return result.toDataStreamResponse({
    headers: {
      "X-MemForks-Branch": branch,
      "X-MemForks-Recalled": encodeURIComponent(JSON.stringify(recalled)),
    },
  });
}
