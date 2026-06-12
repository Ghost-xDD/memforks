import type { ChatOpenAI } from "@langchain/openai";

interface TavilyResponse {
  answer?: string;
  results?: Array<{ content: string }>;
}

/**
 * Web search via Tavily when TAVILY_API_KEY is set.
 * Falls back to the LLM's own knowledge when the key is absent or the request fails.
 */
export async function webSearch(query: string, llm: ChatOpenAI): Promise<string> {
  const tavilyKey = process.env.TAVILY_API_KEY;

  if (tavilyKey) {
    try {
      const resp = await fetch("https://api.tavily.com/search", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key:        tavilyKey,
          query,
          max_results:    5,
          include_answer: true,
        }),
      });

      if (resp.ok) {
        const data = await resp.json() as TavilyResponse;
        if (data.answer) return data.answer;
        if (data.results?.length) return data.results.map(r => r.content).join("\n\n");
      }
    } catch {
      // fall through to LLM
    }
  }

  // LLM-knowledge fallback
  const res = await llm.invoke([
    {
      role:    "system",
      content: "You are a research assistant. Provide detailed, accurate information based on your training knowledge.",
    },
    {
      role:    "user",
      content: `Research and summarize the following topic thoroughly:\n\n${query}`,
    },
  ]);

  return String(res.content);
}
