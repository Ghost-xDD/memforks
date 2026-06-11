import { MemForksClient } from "@memfork/core";

let clientPromise: Promise<MemForksClient> | null = null;

export function getMemForksClient(): Promise<MemForksClient> {
  if (!clientPromise) {
    clientPromise = MemForksClient.connect().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

export interface RecalledFact {
  text: string;
  distance: number;
}

export async function recallFacts(
  query: string,
  branch: string,
  limit = 5,
  threshold = 0.4,
): Promise<RecalledFact[]> {
  const client = await getMemForksClient();
  const facts = await client.recall(query, { branch, limit });
  return facts
    .filter((f) => typeof f.distance !== "number" || f.distance < threshold)
    .map((f) => ({ text: String(f.text ?? ""), distance: f.distance }));
}

export function formatRecalledContext(branch: string, facts: RecalledFact[]): string {
  if (facts.length === 0) return "";
  return [
    `--- MemForks memory (branch: ${branch}) ---`,
    ...facts.map((f, i) => `[${i + 1}] ${f.text}`),
    "--- end of recalled context ---",
  ].join("\n");
}
