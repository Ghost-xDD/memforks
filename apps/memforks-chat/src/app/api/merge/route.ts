import { getMemForksClient, recallFacts } from "@/lib/memfork";

interface MergeRequest {
  from: string;
  into: string;
}

const SWEEP_QUERIES = [
  "facts about this project and conversation",
  "user preferences decisions and technical choices",
  "user background goals context and identity",
];

export async function POST(req: Request) {
  const { from, into } = (await req.json()) as MergeRequest;

  if (!from?.trim() || !into?.trim()) {
    return Response.json({ error: "from and into are required" }, { status: 400 });
  }
  if (from === into) {
    return Response.json({ error: "from and into must be different" }, { status: 400 });
  }

  try {
    const sweepResults = await Promise.all(
      SWEEP_QUERIES.map((q) => recallFacts(q, from, 10).catch(() => [])),
    );

    const seen = new Set<string>();
    const facts: string[] = [];
    for (const batch of sweepResults) {
      for (const f of batch) {
        const key = f.text.trim().slice(0, 120);
        if (!seen.has(key)) {
          seen.add(key);
          facts.push(f.text);
        }
      }
    }

    if (facts.length === 0) {
      return Response.json({ merged: 0, message: "No facts found on source branch" });
    }

    const client = await getMemForksClient();
    const { blobId } = await client.commit(into, {
      facts,
      message: `Merge from ${from}`,
    });

    console.log(`[memfork] merge ${from} → ${into}: ${facts.length} facts, blob ${blobId}`);
    return Response.json({ merged: facts.length, blobId });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
