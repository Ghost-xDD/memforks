import { recallFacts } from "@/lib/memfork";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const into = searchParams.get("into") ?? "main";
  const query =
    searchParams.get("query") ?? "facts about this project conversation and user";

  if (!from?.trim()) {
    return Response.json({ error: "from is required" }, { status: 400 });
  }

  const [fromFacts, intoFacts] = await Promise.all([
    recallFacts(query, from, 10).catch(() => []),
    recallFacts(query, into, 10).catch(() => []),
  ]);

  return Response.json({ from: fromFacts, into: intoFacts, query });
}
