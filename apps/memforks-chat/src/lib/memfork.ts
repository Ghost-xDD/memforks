import { MemForksClient } from "@memfork/core";

const TESTNET_RELAYER = "https://relayer.staging.memwal.ai";
const MAINNET_RELAYER = "https://relayer.memory.walrus.xyz";

function defaultRelayerForNetwork(network: string | undefined) {
  return network === "mainnet" ? MAINNET_RELAYER : TESTNET_RELAYER;
}

let clientPromise: Promise<MemForksClient> | null = null;

export function getMemForksClient(): Promise<MemForksClient> {
  if (!clientPromise) {
    const network   = process.env["MEMFORK_NETWORK"];
    const serverUrl = process.env["MEMFORK_RELAYER_URL"] ?? defaultRelayerForNetwork(network);

    const memwalAccount = process.env["MEMFORK_MEMWAL_ACCOUNT"];
    const memwalKey     = process.env["MEMFORK_MEMWAL_KEY"];

    clientPromise = MemForksClient.connect({
      treeId:     process.env["MEMFORK_TREE_ID"]!,
      signer:     process.env["MEMFORK_PRIVATE_KEY"]!,
      network:    (network ?? "testnet") as "testnet" | "mainnet",
      sponsorUrl: process.env["MEMFORK_SPONSOR_URL"],
      ...(memwalAccount && memwalKey
        ? { memwal: { accountId: memwalAccount, delegateKey: memwalKey, serverUrl } }
        : {}),
    }).catch((err) => {
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

/**
 * MemWal stores full commit-payload JSON. Extract the human-readable fact text
 * from delta.facts, falling back to the raw string if it is not a commit blob.
 */
function extractFactText(raw: string): string {
  try {
    const payload = JSON.parse(raw) as {
      delta?: { facts?: unknown[] };
      type?: string;
    };
    if (payload.type === "commit" && Array.isArray(payload.delta?.facts)) {
      return (payload.delta.facts as string[])
        .filter((f) => typeof f === "string" && f.trim())
        .join("\n\n");
    }
  } catch {
    // not JSON
  }
  return raw;
}

export async function recallFacts(
  query: string,
  branch: string,
  limit = 5,
  // Distance cutoff. MemWal returns cosine-style distances where lower = closer.
  // 0 disables filtering and trusts MemWal's top-N ranking. A strict value here
  // silently drops relevant facts, which reads as "the agent has no memory".
  threshold = 0,
): Promise<RecalledFact[]> {
  const client = await getMemForksClient();
  const facts = await client.recall(query, { branch, limit });

  const mapped = facts
    .filter((f) => threshold <= 0 || typeof f.distance !== "number" || f.distance < threshold)
    .map((f) => ({ text: extractFactText(String(f.text ?? "")), distance: f.distance }))
    .filter((f) => f.text.trim().length > 0);

  console.log(
    `[memfork] recall branch=${branch} query=${JSON.stringify(query.slice(0, 60))} ` +
      `→ ${facts.length} raw, ${mapped.length} after filter` +
      (facts.length
        ? ` (distances: ${facts.map((f) => f.distance?.toFixed?.(3) ?? "?").join(", ")})`
        : ""),
  );

  return mapped;
}

export function formatRecalledContext(branch: string, facts: RecalledFact[]): string {
  if (facts.length === 0) return "";
  return [
    `--- MemForks memory (branch: ${branch}) ---`,
    ...facts.map((f, i) => `[${i + 1}] ${f.text}`),
    "--- end of recalled context ---",
  ].join("\n");
}
