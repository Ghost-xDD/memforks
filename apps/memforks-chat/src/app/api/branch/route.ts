import { getMemForksClient } from "@/lib/memfork";

interface BranchRequest {
  from: string;
  name?: string;
}

export async function POST(req: Request) {
  const { from, name } = (await req.json()) as BranchRequest;

  if (!from?.trim()) {
    return Response.json({ error: "from branch is required" }, { status: 400 });
  }

  const branchName = name?.trim() || `explore/${Date.now().toString(36)}`;

  try {
    const client = await getMemForksClient();
    const digest = await client.branch(branchName, { from });
    return Response.json({ branch: branchName, digest });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
