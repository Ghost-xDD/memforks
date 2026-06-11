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

  const recalled = await recallFacts(query, branch).catch(() => []);
  const recalledContext = formatRecalledContext(branch, recalled);

  const model = withMemForks(openai("gpt-4o-mini"), {
    branch,
    recallLimit: 0,
    autoCommit: true,
  });

  const systemParts: string[] = [
    "You are a helpful assistant with persistent memory via MemForks. " +
      "Facts from prior sessions on this branch are provided below. " +
      "Reference them naturally when relevant.",
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
