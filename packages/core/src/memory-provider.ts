/**
 * MemoryProvider — storage/recall abstraction behind MemForksClient.
 *
 * `commit()`, `recall()`, and `history()` never talk to MemWal directly;
 * they go through whatever MemoryProvider is configured for the tree.
 * This is the seam that lets a branch's blob+recall plane run on a local,
 * zero-deps backend instead of MemWal/Walrus, while branch/merge/ACL stay
 * on Sui (SPEC Model A — keep the chain, swap the blob store).
 *
 * Contract:
 *   - `rememberAndWait` durably stores `text` and returns an opaque `blob_id`.
 *     Opaque means MemForks only ever treats it as a string key. A local
 *     provider can use a content hash; MemWal uses a real Walrus blob ID.
 *   - `recall` returns the top `limit` hits for `query` ordered by ascending
 *     `distance` (0 = exact match). An empty query is a valid "give me
 *     everything" call — client.history() relies on this.
 *   - `restore` is optional. MemWal needs it to guarantee index completeness;
 *     a local provider with no external index can omit it (or leave it a no-op).
 *
 * A live `MemWal` instance already satisfies this interface structurally —
 * no adapter class is needed. See `providerForBranch()` in client.ts.
 */

export interface MemoryRecallHit {
  distance: number;
  blob_id: string;
  text: string;
}

export interface MemoryProvider {
  rememberAndWait(text: string): Promise<{ blob_id: string }>;
  recall(opts: {
    query: string;
    limit: number;
  }): Promise<{ results: MemoryRecallHit[] }>;
  restore?(): Promise<void>;
}

// ─── Backend selection (client config) ────────────────────────────────────────

export interface MemWalBackendConfig {
  kind: 'memwal';
  accountId: string;
  delegateKey: string;
  serverUrl?: string;
}

export interface LocalBackendConfig {
  kind: 'local';
  /** Root dir for per-namespace JSONL files. Default: .memfork/local-memory. */
  dir?: string;
  /**
   * Optional embedding function for semantic (cosine) recall instead of the
   * zero-deps keyword scorer. Point this at a local model (e.g. Ollama) to
   * keep recall fully offline.
   */
  embed?: (text: string) => Promise<number[]> | number[];
}

export type MemoryBackendConfig = MemWalBackendConfig | LocalBackendConfig;

// ─── LocalMemoryProvider ───────────────────────────────────────────────────────

/**
 * Zero-deps, offline MemoryProvider. One append-only JSONL file per branch
 * namespace under `dir`. No network, no wallet, no relayer.
 *
 * Recall defaults to a small TF-style keyword scorer. Pass `embed` to switch
 * to cosine-similarity recall against a local model.
 */
export class LocalMemoryProvider implements MemoryProvider {
  private readonly filePath: string;
  private readonly embed: LocalBackendConfig['embed'];

  constructor(
    namespace: string,
    config: Omit<LocalBackendConfig, 'kind'> = {},
  ) {
    const dir = config.dir ?? '.memfork/local-memory';
    this.embed = config.embed;
    // Namespace already looks like memforks/<treeHex>/<branch> — flatten to a filename.
    const safe = namespace.replace(/[^a-zA-Z0-9._-]/g, '_');
    this.filePath = `${dir}/${safe}.jsonl`;
  }

  async rememberAndWait(text: string): Promise<{ blob_id: string }> {
    const { mkdir, appendFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const { createHash } = await import('node:crypto');

    const ts_ms = Date.now();
    // Content-addressed + timestamp so a duplicate commit is still a distinct
    // history row (history() sees every commit), while remaining opaque to the
    // rest of MemForks.
    const blob_id = `local:${createHash('sha256')
      .update(text)
      .update(String(ts_ms))
      .digest('hex')
      .slice(0, 32)}`;

    let embedding: number[] | undefined;
    if (this.embed) {
      try {
        embedding = await this.embed(text);
      } catch {
        embedding = undefined; // fall back to keyword recall for this row
      }
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    const row = JSON.stringify({
      blob_id,
      text,
      ts_ms,
      ...(embedding ? { embedding } : {}),
    });
    await appendFile(this.filePath, row + '\n', 'utf8');

    return { blob_id };
  }

  async recall(opts: {
    query: string;
    limit: number;
  }): Promise<{ results: MemoryRecallHit[] }> {
    const rows = await this.readRows();
    if (rows.length === 0) return { results: [] };

    // Empty query: everything, most-recent-first (used by client.history()).
    if (!opts.query.trim()) {
      const results = rows
        .slice()
        .sort((a, b) => b.ts_ms - a.ts_ms)
        .slice(0, opts.limit)
        .map((r) => ({ distance: 0, blob_id: r.blob_id, text: r.text }));
      return { results };
    }

    let queryEmbedding: number[] | undefined;
    if (this.embed) {
      try {
        queryEmbedding = await this.embed(opts.query);
      } catch {
        queryEmbedding = undefined;
      }
    }

    const scored = rows.map((r) => ({
      row: r,
      distance:
        queryEmbedding && r.embedding
          ? cosineDistance(queryEmbedding, r.embedding)
          : keywordDistance(opts.query, r.text),
    }));

    scored.sort((a, b) => a.distance - b.distance);

    return {
      results: scored.slice(0, opts.limit).map((s) => ({
        distance: s.distance,
        blob_id: s.row.blob_id,
        text: s.row.text,
      })),
    };
  }

  // No external index to warm — everything lives in the JSONL file already.
  async restore(): Promise<void> {}

  private async readRows(): Promise<
    Array<{
      blob_id: string;
      text: string;
      ts_ms: number;
      embedding?: number[];
    }>
  > {
    const { readFile } = await import('node:fs/promises');
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return []; // namespace has no commits yet
    }
    const rows: Array<{
      blob_id: string;
      text: string;
      ts_ms: number;
      embedding?: number[];
    }> = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* skip a corrupted line rather than fail the whole recall */
      }
    }
    return rows;
  }
}

// ─── Scoring helpers ────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** 0 = all query terms present, up to 1 = no overlap. Cheap TF-style overlap, no deps. */
function keywordDistance(query: string, text: string): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 1;
  const t = tokenize(text);
  const tSet = new Set(t);
  let hits = 0;
  for (const term of q) if (tSet.has(term)) hits++;
  return 1 - hits / q.size;
}

function cosineDistance(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  if (magA === 0 || magB === 0) return 1;
  const cosineSim = dot / (Math.sqrt(magA) * Math.sqrt(magB));
  return 1 - cosineSim;
}
