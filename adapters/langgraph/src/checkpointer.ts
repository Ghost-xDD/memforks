/**
 * MemForksCheckpointer — implements LangGraph's BaseCheckpointSaver interface.
 *
 * Storage model:
 *   - Each `put()` call (checkpoint write) commits a snapshot of the graph
 *     state to MemWal under the current branch and anchors the blob_id on Sui.
 *   - `get()` / `getTuple()` restores state by reading the latest commit's
 *     blob from MemWal, or falls back to `recall()` for semantic lookup.
 *   - Thread IDs map to branch names: thread "abc" → branch "thread/abc".
 *     This keeps each LangGraph thread's memory isolated and merge-able.
 *
 * Merge semantics:
 *   When two agents running on separate branches converge (e.g. a supervisor
 *   aggregates sub-agent results), call `checkpointer.proposeMerge(src, dst)`
 *   to open a merge proposal. The on-chain resolver handles the rest.
 */

import type {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
  RunnableConfig,
  SerializerProtocol,
} from "@langchain/langgraph-checkpoint";

import { MemForksClient, type MemForksClientConfig, type MemWalConfig } from "@memfork/core";

// ─── Config ───────────────────────────────────────────────────────────────────

export interface MemForksCheckpointerConfig {
  /** Sui MemoryTree object ID. */
  treeId: string;
  /**
   * Signer. Ed25519 keypair, bech32 `suiprivkey1…`, or 64-char hex.
   */
  signer: string;
  /** MemWal delegate credentials. */
  memwal: MemWalConfig;
  /**
   * Default branch for checkpoints.
   * Defaults to "main". Individual calls can override via thread_id.
   */
  branch?: string;
  /** Map thread IDs to branch names. Defaults to "thread/<thread_id>". */
  threadToBranch?: (threadId: string) => string;
  /** Sui network. Defaults to "testnet". */
  network?: "testnet" | "mainnet" | "devnet" | "localnet";
  /** Override RPC URL. */
  rpcUrl?: string;
  /** MemForks package ID override. */
  packageId?: string;
  /** Gas sponsor URL (optional). */
  sponsorUrl?: string;
}

// ─── Serialisation helpers ────────────────────────────────────────────────────

function checkpointToText(
  checkpoint: Checkpoint,
  metadata: CheckpointMetadata,
  threadId: string,
): string {
  return JSON.stringify({
    checkpoint,
    metadata,
    threadId,
    __memforks_version: 1,
  });
}

function textToCheckpointTuple(
  text: string,
  config: RunnableConfig,
  blobId: string,
): CheckpointTuple | undefined {
  try {
    const parsed = JSON.parse(text) as {
      checkpoint: Checkpoint;
      metadata: CheckpointMetadata;
    };
    return {
      config,
      checkpoint: parsed.checkpoint,
      metadata: parsed.metadata,
      pendingWrites: [],
    };
  } catch {
    return undefined;
  }
}

// ─── MemForksCheckpointer ─────────────────────────────────────────────────────

export class MemForksCheckpointer implements BaseCheckpointSaver {
  // LangGraph serializer — required by the interface but we do our own JSON.
  readonly serde: SerializerProtocol = {
    dumpsTyped: (data: unknown) => ["json", JSON.stringify(data)],
    loadsTyped: ([_type, data]: [string, string]) => JSON.parse(data) as unknown,
  };

  private readonly client: MemForksClient;
  private readonly defaultBranch: string;
  private readonly threadToBranch: (threadId: string) => string;

  private constructor(
    client: MemForksClient,
    defaultBranch: string,
    threadToBranch: (threadId: string) => string,
  ) {
    this.client = client;
    this.defaultBranch = defaultBranch;
    this.threadToBranch = threadToBranch;
  }

  // ─── Factory ────────────────────────────────────────────────────────────────

  static async create(cfg: MemForksCheckpointerConfig): Promise<MemForksCheckpointer> {
    const clientCfg: MemForksClientConfig = {
      treeId:    cfg.treeId,
      signer:    cfg.signer,
      memwal:    cfg.memwal,
      network:   cfg.network,
      rpcUrl:    cfg.rpcUrl,
      packageId: cfg.packageId,
      sponsorUrl: cfg.sponsorUrl,
    };
    const client = await MemForksClient.connect(clientCfg);
    const defaultBranch = cfg.branch ?? "main";
    const threadToBranch = cfg.threadToBranch ?? ((id) => `thread/${id}`);

    return new MemForksCheckpointer(client, defaultBranch, threadToBranch);
  }

  // ─── Branch resolution ──────────────────────────────────────────────────────

  private branchForConfig(config?: RunnableConfig): string {
    const threadId = config?.configurable?.thread_id as string | undefined;
    if (threadId) return this.threadToBranch(threadId);
    return this.defaultBranch;
  }

  // ─── BaseCheckpointSaver API ────────────────────────────────────────────────

  /**
   * Retrieve the most recent checkpoint tuple for the given config.
   *
   * Strategy:
   *   1. If `config.configurable.checkpoint_id` is set (LangGraph passes this
   *      on subsequent calls after a put()), use it as a precise recall query.
   *      A checkpoint UUID is unique — semantic search will return the exact blob.
   *   2. If `config.configurable.memforks_blob_id` is set (we stored this in
   *      put()), use it as the query anchor for even more precise retrieval.
   *   3. Otherwise (fresh thread, no prior checkpoint) return undefined —
   *      LangGraph treats this as "no checkpoint exists yet", which is correct.
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const branch   = this.branchForConfig(config);
    const cfgbl    = config.configurable ?? {};
    const threadId = (cfgbl.thread_id as string | undefined) ?? branch;

    // Prefer the most specific anchor available.
    const blobId       = cfgbl.memforks_blob_id as string | undefined;
    const checkpointId = cfgbl.checkpoint_id    as string | undefined;

    // No prior checkpoint on this thread — fresh start.
    if (!blobId && !checkpointId) return undefined;

    try {
      // Build a highly specific query from the stored checkpoint UUID.
      // A UUID query will only match the exact blob it was stored in.
      const query = blobId
        ? `memforks_blob_id:${blobId}`
        : `checkpoint_id:${checkpointId} thread_id:${threadId}`;

      const results = await this.client.recall(query, { branch, limit: 1 });
      if (results.length === 0) return undefined;
      return textToCheckpointTuple(results[0].text, config, results[0].blobId);
    } catch {
      return undefined;
    }
  }

  /**
   * List recent checkpoints. Returns an async generator of CheckpointTuples.
   */
  async *list(
    config: RunnableConfig,
    options?: { limit?: number; before?: RunnableConfig },
  ): AsyncGenerator<CheckpointTuple> {
    const branch = this.branchForConfig(config);
    const threadId = (config.configurable?.thread_id as string | undefined) ?? branch;
    const limit = options?.limit ?? 5;

    try {
      const results = await this.client.recall(
        `checkpoint thread_id=${threadId}`,
        { branch, limit },
      );
      for (const r of results) {
        const tuple = textToCheckpointTuple(r.text, config, r.blobId);
        if (tuple) yield tuple;
      }
    } catch {
      return;
    }
  }

  /**
   * Write a checkpoint to MemWal + anchor on Sui.
   * Returns the updated config with the blob_id stored in metadata.
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const branch = this.branchForConfig(config);
    const threadId = (config.configurable?.thread_id as string | undefined) ?? branch;

    const text    = checkpointToText(checkpoint, metadata, threadId);
    const step    = (metadata as Record<string, unknown>).step ?? "?";
    const message = `checkpoint: thread=${threadId} step=${step}`;

    // Include indexable anchor facts alongside the checkpoint payload so
    // getTuple() can locate this exact blob via precise semantic queries.
    const { blobId } = await this.client.commit(branch, {
      facts: [
        `checkpoint_id:${checkpoint.id} thread_id:${threadId} step:${step}`,
        text,
      ],
      message,
    });

    return {
      ...config,
      configurable: {
        ...config.configurable,
        checkpoint_id:        checkpoint.id,
        checkpoint_ns:        (config.configurable?.checkpoint_ns as string | undefined) ?? "",
        memforks_blob_id:     blobId,
        memforks_branch:      branch,
      },
    };
  }

  /**
   * Write pending writes (intermediate task results) to the branch.
   * These are lightweight — stored as a single facts commit, not a full checkpoint.
   */
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const branch = this.branchForConfig(config);
    if (writes.length === 0) return;

    const facts = writes.map(([channel, value]) =>
      `pending_write task=${taskId} channel=${channel}: ${JSON.stringify(value)}`,
    );

    await this.client.commit(branch, {
      facts,
      message: `pending_writes: task=${taskId} count=${writes.length}`,
    });
  }

  // ─── MemForks-specific extras ────────────────────────────────────────────────

  /**
   * Propose a merge of two thread branches.
   * Non-blocking — the on-chain resolver handles attestation and finalization.
   *
   * @param fromThread  Source thread ID (or raw branch name).
   * @param intoThread  Target thread ID (or raw branch name).
   * @param resolverId  Sui ResolverRef object ID.
   */
  async proposeMerge(opts: {
    fromThread: string;
    intoThread: string;
    resolverId: string;
    ttlMs?: number;
  }): Promise<string> {
    return this.client.proposeMerge({
      fromBranch: this.threadToBranch(opts.fromThread),
      intoBranch: this.threadToBranch(opts.intoThread),
      resolverId: opts.resolverId,
      ttlMs:      opts.ttlMs,
    });
  }

  /**
   * Recall facts from a thread's branch using semantic search.
   */
  async recall(
    query: string,
    opts: { threadId?: string; limit?: number } = {},
  ): Promise<Array<{ distance: number; blobId: string; text: string }>> {
    const branch = opts.threadId
      ? this.threadToBranch(opts.threadId)
      : this.defaultBranch;
    return this.client.recall(query, { branch, limit: opts.limit });
  }

  /** Expose the underlying MemForksClient for advanced use. */
  get memforks(): MemForksClient {
    return this.client;
  }
}

// ─── Factory shorthand ────────────────────────────────────────────────────────

export async function createMemForksCheckpointer(
  cfg: MemForksCheckpointerConfig,
): Promise<MemForksCheckpointer> {
  return MemForksCheckpointer.create(cfg);
}
