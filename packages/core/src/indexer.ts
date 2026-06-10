/**
 * MemForks event-driven indexer.
 *
 * Model A: regular commits are off-chain Walrus blobs and emit no Sui events.
 * The indexer tracks branch state and merge anchors from the events that DO fire:
 *
 *   tree::TreeCreated    — register tree + default branch
 *   tree::BranchCreated  — register new branch, record its namespace
 *   resolver::MergeFinalized — record merge anchor, advance branch head
 *
 * Full off-chain commit history (walking the Walrus blob hash chain from each
 * merge anchor's from_head_blob_id / into_head_blob_id) requires MemWal recall
 * access and is implemented in a separate DAG walker (services/indexer/).
 *
 * Usage:
 *   const idx = new MemForksIndexer({ treeId, suiClient, packageId });
 *   idx.start();
 *   idx.on("branch",          h => ...);
 *   idx.on("merge_finalized", h => ...);
 *   const head = idx.branchHead("main");   // settled Walrus blob ID
 */

import { SuiJsonRpcClient as SuiClient } from "@mysten/sui/jsonRpc";
import type {
  BranchCreatedEvent,
  TreeCreatedEvent,
  MergeFinalizedEvent,
} from "./types.js";

// ─── Public state types ───────────────────────────────────────────────────────

/** The settled state of a branch as known from on-chain events. */
export interface BranchState {
  branch: string;
  /** MemWal namespace for this branch (memforks/<tree_id>/<branch>). */
  namespace: string;
  /** Walrus blob ID the branch head was last advanced to. Empty = at genesis. */
  headBlobId: string;
  /** Branch this was forked from. */
  fromBranch: string;
}

/**
 * An on-chain merge settlement record.
 * The from_head and into_head blob IDs are the entry points for walking
 * the off-chain Walrus blob hash chain to reconstruct full commit history.
 */
export interface MergeAnchor {
  proposalId: string;
  treeId: string;
  /** The into_branch that received the merge. */
  intoBranch: string;
  /** On-chain MemoryCommit object ID — the permanent audit anchor. */
  mergeCommitId: string;
  /** Walrus blob ID the into_branch head was advanced to. */
  resolvedBlobId: string;
  /** from_branch tip at merge time — walk backwards to find all from_branch commits. */
  fromHeadBlobId: string;
  /** into_branch tip at merge time — walk backwards to find all pre-merge into_branch commits. */
  intoHeadBlobId: string;
  indexedAt: number;
}

// ─── Indexer event types ──────────────────────────────────────────────────────

type IndexerEvent =
  | { type: "branch";          data: BranchState }
  | { type: "tree_created";    data: TreeCreatedEvent }
  | { type: "merge_finalized"; data: MergeAnchor };

type Handler<T> = (data: T) => void;

// ─── Config ───────────────────────────────────────────────────────────────────

export interface MemForksIndexerConfig {
  treeId: string;
  suiClient: SuiClient;
  packageId: string;
  pollIntervalMs?: number;
}

// ─── Indexer ─────────────────────────────────────────────────────────────────

export class MemForksIndexer {
  private readonly treeId: string;
  private readonly suiClient: SuiClient;
  private readonly packageId: string;
  private readonly pollIntervalMs: number;

  private branches = new Map<string, BranchState>();
  private merges: MergeAnchor[] = [];
  private cursors = new Map<string, string>();
  private listeners = new Map<string, Handler<unknown>[]>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(cfg: MemForksIndexerConfig) {
    this.treeId         = cfg.treeId;
    this.suiClient      = cfg.suiClient;
    this.packageId      = cfg.packageId;
    this.pollIntervalMs = cfg.pollIntervalMs ?? 3_000;
  }

  // ─── Control ─────────────────────────────────────────────────────────────

  start(): this {
    if (this.timer) return this;
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

  /** Current settled branch head (Walrus blob ID). Empty string = at genesis. */
  branchHead(branch: string): string {
    return this.branches.get(branch)?.headBlobId ?? "";
  }

  getBranch(branch: string): BranchState | undefined {
    return this.branches.get(branch);
  }

  allBranches(): BranchState[] {
    return [...this.branches.values()];
  }

  allMerges(): MergeAnchor[] {
    return [...this.merges];
  }

  // ─── Event subscription ───────────────────────────────────────────────────

  on(event: "branch",          fn: Handler<BranchState>): this;
  on(event: "tree_created",    fn: Handler<TreeCreatedEvent>): this;
  on(event: "merge_finalized", fn: Handler<MergeAnchor>): this;
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
      this.fetchEvents("tree",     "BranchCreated"),
      this.fetchEvents("tree",     "TreeCreated"),
      this.fetchEvents("resolver", "MergeFinalized"),
    ]);
  }

  private async fetchEvents(mod: string, name: string): Promise<void> {
    const eventType = `${this.packageId}::${mod}::${name}`;
    const cursor    = this.cursors.get(eventType);

    try {
      const result = await this.suiClient.queryEvents({
        query: { MoveEventType: eventType },
        cursor: cursor ? { txDigest: cursor, eventSeq: "0" } : undefined,
        limit: 50,
        order: "ascending",
      });

      for (const ev of result.data) {
        this.handleEvent(mod, name, ev.parsedJson as Record<string, unknown>);
        this.cursors.set(eventType, ev.id.txDigest);
      }
    } catch {
      // Transient network errors — continue on next poll.
    }
  }

  private handleEvent(mod: string, name: string, json: Record<string, unknown>): void {
    if (mod === "tree" && name === "BranchCreated") {
      const ev = json as unknown as BranchCreatedEvent;
      if (ev.tree_id !== this.treeId) return;

      const state: BranchState = {
        branch:     ev.branch,
        namespace:  ev.memwal_namespace,
        headBlobId: "",   // genesis at birth; updated when a merge lands
        fromBranch: ev.from_branch,
      };
      this.branches.set(ev.branch, state);
      this.emit({ type: "branch", data: state });
    }

    if (mod === "tree" && name === "TreeCreated") {
      const ev = json as unknown as TreeCreatedEvent;
      if (ev.tree_id !== this.treeId) return;
      // Seed the default branch (BranchCreated is not emitted for the default branch).
      const hex = ev.tree_id.startsWith("0x") ? ev.tree_id.slice(2) : ev.tree_id;
      const ns  = `memforks/${hex}/${ev.default_branch}`;
      if (!this.branches.has(ev.default_branch)) {
        this.branches.set(ev.default_branch, {
          branch: ev.default_branch, namespace: ns, headBlobId: "", fromBranch: "",
        });
      }
      this.emit({ type: "tree_created", data: ev });
    }

    if (mod === "resolver" && name === "MergeFinalized") {
      const ev = json as unknown as (MergeFinalizedEvent & {
        from_head_blob_id?: string;
        into_head_blob_id?: string;
      });
      if (ev.tree_id !== this.treeId) return;

      // Find which branch was merged into by looking up the proposal.
      // The event includes merge_commit_id and resolved_blob_id; we need the
      // branch name from the proposal. For now we track what we have.
      const anchor: MergeAnchor = {
        proposalId:     ev.proposal_id,
        treeId:         ev.tree_id,
        intoBranch:     "",                         // filled below if known
        mergeCommitId:  ev.merge_commit_id,
        resolvedBlobId: ev.resolved_blob_id,
        fromHeadBlobId: ev.from_head_blob_id ?? "",
        intoHeadBlobId: ev.into_head_blob_id ?? "",
        indexedAt:      Date.now(),
      };

      // Update any branch whose head matches into_head_blob_id → advance to resolved_blob_id.
      for (const [branch, state] of this.branches) {
        if (state.headBlobId === anchor.intoHeadBlobId) {
          state.headBlobId = anchor.resolvedBlobId;
          anchor.intoBranch = branch;
          break;
        }
      }

      this.merges.push(anchor);
      this.emit({ type: "merge_finalized", data: anchor });
    }
  }
}
