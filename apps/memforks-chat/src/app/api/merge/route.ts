import { getMemForksClient } from "@/lib/memfork";

interface MergeRequest {
  from: string;
  into: string;
}

export async function POST(req: Request) {
  const { from, into } = (await req.json()) as MergeRequest;

  if (!from?.trim() || !into?.trim()) {
    return Response.json({ error: "from and into are required" }, { status: 400 });
  }
  if (from === into) {
    return Response.json({ error: "from and into must be different" }, { status: 400 });
  }

  try {
    const client = await getMemForksClient();
    const { digest, mergedCount, blobId, proposalId } = await client.merge(from, into);

    if (mergedCount === 0) {
      return Response.json({ merged: 0, message: "No facts found on source branch" });
    }

    return Response.json({
      merged: mergedCount,
      blobId,
      ...(digest     && { digest }),
      ...(proposalId && { proposalId }),
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
