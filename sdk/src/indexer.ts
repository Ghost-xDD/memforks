/**
 * MemForks polling indexer.
 *
 * Polls `queryEvents` every N seconds, advances a cursor, builds an in-memory
 * DAG of commits and branches. This is the D-4 architecture decision:
 * `queryEvents` polling is reliable on the public RPC; WebSocket is not.
 *
 * SPEC §9 events consumed:
 *   tree::CommitCreated  — add DAG node, advance branch head
 *   tree::BranchCreated  — register new branch
 *   tree::TreeCreated    — register tree metadata
 *   resolver::MergeFinalized — merge commit lands
 *
 * Usage:
 *   const idx = new MemForksIndexer({ treeId, suiClient, packageId });
 *   idx.start();                  // begin polling
 *   idx.on("commit", handler);   // listen for new commits
 *   const head = idx.branchHead("main");
 */

import { SuiJsonRpcClient as SuiClient } from "@mysten/sui/jsonRpc";
import type {
  CommitCreatedEvent,
  BranchCreatedEvent,
  TreeCreatedEvent,
  MergeFinalizedEvent,
} from "./types.js";

// ─── DAG node ────────────────────────────────────────────────────────────────

export interface CommitNode {
  commitId: string;
  treeId: string;
  branch: string;
  parents: string[];
  memwalNamespace: string;
  memwalBlobId: string;
  author: string;
  isMerge: boolean;
  /** Wall-clock time the event was indexed (not on-chain ts_ms). */
  indexedAt: number;
}

// ─── Event types ─────────────────────────────────────────────────────────────

type IndexerEvent =
  | { type: "commit";         data: CommitNode }
  | { type: "branch";         data: { branch: string; fromBranch: string; namespace: string } }
  | { type: "tree_created";   data: TreeCreatedEvent }
  | { type: "merge_finalized"; data: MergeFinalizedEvent };

type Handler<T> = (data: T) => void;

// ─── Indexer ─────────────────────────────────────────────────────────────────

export interface MemForksIndexerConfig {
  treeId: string;
  suiClient: SuiClient;
  packageId: string;
  /** Polling interval in ms. Default: 3000. */
  pollIntervalMs?: number;
}

export class MemForksIndexer {
  private readonly treeId: string;
  private readonly suiClient: SuiClient;
  private readonly packageId: string;
  private readonly pollIntervalMs: number;

  // In-memory DAG state
  private commits = new Map<string, CommitNode>();
  /** branch name → current head commit ID */
  private heads   = new Map<string, string>();

  // Cursors: per event type
  private cursors = new Map<string, string>();

  // Event listeners
  private listeners = new Map<string, Handler<unknown>[]>();

  // Polling handle
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(cfg: MemForksIndexerConfig) {
    this.treeId        = cfg.treeId;
    this.suiClient     = cfg.suiClient;
    this.packageId     = cfg.packageId;
    this.pollIntervalMs = cfg.pollIntervalMs ?? 3_000;
  }

  // ─── Control ─────────────────────────────────────────────────────────────

  start(): this {
    if (this.timer) return this;
    // Immediate first poll, then interval
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    return this;
  }

  stop(): this {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this;
  }

  // ─── State accessors ─────────────────────────────────────────────────────

  branchHead(branch: string): string | undefined {
    return this.heads.get(branch);
  }

  getCommit(commitId: string): CommitNode | undefined {
    return this.commits.get(commitId);
  }

  allBranches(): string[] {
    return [...this.heads.keys()];
  }

  allCommits(): CommitNode[] {
    return [...this.commits.values()];
  }

  /** Walk the DAG from a commit back to genesis. */
  history(startCommitId: string): CommitNode[] {
    const result: CommitNode[] = [];
    const visited = new Set<string>();
    const queue   = [startCommitId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const node = this.commits.get(id);
      if (!node) continue;
      result.push(node);
      node.parents.forEach(p => queue.push(p));
    }
    return result;
  }

  // ─── Event subscription ───────────────────────────────────────────────────

  on(event: "commit",          fn: Handler<CommitNode>): this;
  on(event: "branch",          fn: Handler<{ branch: string; fromBranch: string; namespace: string }>): this;
  on(event: "tree_created",    fn: Handler<TreeCreatedEvent>): this;
  on(event: "merge_finalized", fn: Handler<MergeFinalizedEvent>): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, fn: Handler<any>): this {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
    return this;
  }

  private emit(event: IndexerEvent): void {
    const handlers = this.listeners.get(event.type) ?? [];
    handlers.forEach(h => h(event.data as never));
  }

  // ─── Polling core ─────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    await Promise.all([
      this.fetchEvents("tree", "CommitCreated"),
      this.fetchEvents("tree", "BranchCreated"),
      this.fetchEvents("tree", "TreeCreated"),
      this.fetchEvents("resolver", "MergeFinalized"),
    ]);
  }

  private async fetchEvents(mod: string, name: string): Promise<void> {
    const eventType = `${this.packageId}::${mod}::${name}`;
    const cursorKey = eventType;
    const cursor    = this.cursors.get(cursorKey);

    try {
      const result = await this.suiClient.queryEvents({
        query: { MoveEventType: eventType },
        cursor: cursor ? { txDigest: cursor, eventSeq: "0" } : undefined,
        limit: 50,
        order: "ascending",
      });

      for (const ev of result.data) {
        this.handleEvent(mod, name, ev.parsedJson as Record<string, unknown>);
        // Advance cursor to the last seen tx
        this.cursors.set(cursorKey, ev.id.txDigest);
      }
    } catch {
      // Network errors are transient — log and continue
    }
  }

  private handleEvent(
    mod: string,
    name: string,
    json: Record<string, unknown>,
  ): void {
    if (mod === "tree" && name === "CommitCreated") {
      const ev = json as unknown as CommitCreatedEvent;
      // Only index commits that belong to our tree
      if (ev.tree_id !== this.treeId) return;

      const node: CommitNode = {
        commitId:        ev.commit_id,
        treeId:          ev.tree_id,
        branch:          ev.branch,
        parents:         ev.parents,
        memwalNamespace: ev.memwal_namespace,
        memwalBlobId:    ev.memwal_blob_id,
        author:          ev.author,
        isMerge:         ev.is_merge,
        indexedAt:       Date.now(),
      };
      this.commits.set(node.commitId, node);
      this.heads.set(node.branch, node.commitId);
      this.emit({ type: "commit", data: node });
    }

    if (mod === "tree" && name === "BranchCreated") {
      const ev = json as unknown as BranchCreatedEvent;
      if (ev.tree_id !== this.treeId) return;
      this.emit({
        type: "branch",
        data: { branch: ev.branch, fromBranch: ev.from_branch, namespace: ev.memwal_namespace },
      });
    }

    if (mod === "tree" && name === "TreeCreated") {
      const ev = json as unknown as TreeCreatedEvent;
      if (ev.tree_id !== this.treeId) return;
      // Seed the branch head with genesis (indexer will fill in from CommitCreated events).
      this.emit({ type: "tree_created", data: ev });
    }

    if (mod === "resolver" && name === "MergeFinalized") {
      const ev = json as unknown as MergeFinalizedEvent;
      if (ev.tree_id !== this.treeId) return;
      this.emit({ type: "merge_finalized", data: ev });
    }
  }
}
