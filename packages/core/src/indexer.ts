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
 * Events are polled via GraphQL RPC (JSON-RPC queryEvents is deprecated /
 * disabled on Foundation fullnodes as of 2026-07).
 *
 * Usage:
 *   const idx = new MemForksIndexer({ treeId, suiClient, packageId });
 *   idx.start();
 *   idx.on("branch",          h => ...);
 *   idx.on("merge_finalized", h => ...);
 *   const head = idx.branchHead("main");   // settled Walrus blob ID
 */

import { SuiGraphQLClient } from '@mysten/sui/graphql';
import type { SuiGrpcClient } from './sui.js';
import type {
  BranchCreatedEvent,
  TreeCreatedEvent,
  MergeFinalizedEvent,
} from './types.js';

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
  | { type: 'branch'; data: BranchState }
  | { type: 'tree_created'; data: TreeCreatedEvent }
  | { type: 'merge_finalized'; data: MergeAnchor };

type Handler<T> = (data: T) => void;

const GRAPHQL_URLS: Record<string, string> = {
  mainnet: 'https://graphql.mainnet.sui.io/graphql',
  testnet: 'https://graphql.testnet.sui.io/graphql',
  devnet: 'https://graphql.devnet.sui.io/graphql',
};

// ─── Config ───────────────────────────────────────────────────────────────────

export interface MemForksIndexerConfig {
  treeId: string;
  /** Used for network selection (GraphQL endpoint). */
  suiClient: SuiGrpcClient;
  packageId: string;
  pollIntervalMs?: number;
  /** Override GraphQL endpoint. Default: Mysten public GraphQL for the network. */
  graphqlUrl?: string;
}

// ─── Indexer ──────────────────────────────────────────────────────────────────

export class MemForksIndexer {
  readonly treeId: string;
  private readonly packageId: string;
  private readonly graphql: SuiGraphQLClient;
  private readonly pollMs: number;

  private readonly branches = new Map<string, BranchState>();
  private readonly merges: MergeAnchor[] = [];
  private readonly cursors = new Map<string, string | null>();
  private readonly handlers = new Map<string, Handler<unknown>[]>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(cfg: MemForksIndexerConfig) {
    this.treeId = cfg.treeId;
    this.packageId = cfg.packageId;
    this.pollMs = cfg.pollIntervalMs ?? 5_000;
    const network = cfg.suiClient.network;
    this.graphql = new SuiGraphQLClient({
      network,
      url:
        cfg.graphqlUrl ??
        GRAPHQL_URLS[network] ??
        GRAPHQL_URLS['mainnet']!,
    });
  }

  // ─── Event emitter ────────────────────────────────────────────────────────

  on(event: 'branch', handler: Handler<BranchState>): void;
  on(event: 'tree_created', handler: Handler<TreeCreatedEvent>): void;
  on(event: 'merge_finalized', handler: Handler<MergeAnchor>): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: Handler<any>): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  private emit(ev: IndexerEvent): void {
    for (const h of this.handlers.get(ev.type) ?? []) {
      try {
        h(ev.data);
      } catch {
        /* swallow handler errors */
      }
    }
  }

  // ─── Public accessors ─────────────────────────────────────────────────────

  branchHead(branch: string): string | undefined {
    return this.branches.get(branch)?.headBlobId;
  }

  branchState(branch: string): BranchState | undefined {
    return this.branches.get(branch);
  }

  allBranches(): BranchState[] {
    return [...this.branches.values()];
  }

  mergeAnchors(): MergeAnchor[] {
    return [...this.merges];
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    await Promise.all([
      this.fetchEvents('tree', 'BranchCreated'),
      this.fetchEvents('tree', 'TreeCreated'),
      this.fetchEvents('resolver', 'MergeFinalized'),
    ]);
  }

  private async fetchEvents(mod: string, name: string): Promise<void> {
    const eventType = `${this.packageId}::${mod}::${name}`;
    const after = this.cursors.get(eventType) ?? null;

    try {
      const result = await this.graphql.query({
        query: `query ($type: String!, $after: String) {
          events(filter: { type: $type }, first: 50, after: $after) {
            pageInfo { endCursor hasNextPage }
            nodes {
              contents { json }
              transactionBlock { digest }
            }
          }
        }`,
        variables: { type: eventType, after },
      });

      const events = (
        result.data as {
          events?: {
            pageInfo?: { endCursor?: string | null };
            nodes?: Array<{
              contents?: { json?: Record<string, unknown> };
              transactionBlock?: { digest?: string };
            }>;
          };
        }
      )?.events;

      for (const node of events?.nodes ?? []) {
        const json = node.contents?.json;
        if (json) this.handleEvent(mod, name, json);
      }

      if (events?.pageInfo?.endCursor) {
        this.cursors.set(eventType, events.pageInfo.endCursor);
      }
    } catch {
      // Transient network errors — continue on next poll.
    }
  }

  private handleEvent(
    mod: string,
    name: string,
    json: Record<string, unknown>,
  ): void {
    if (mod === 'tree' && name === 'BranchCreated') {
      const ev = json as unknown as BranchCreatedEvent;
      if (ev.tree_id !== this.treeId) return;

      const state: BranchState = {
        branch: ev.branch,
        namespace: ev.memwal_namespace,
        headBlobId: '', // genesis at birth; updated when a merge lands
        fromBranch: ev.from_branch,
      };
      this.branches.set(ev.branch, state);
      this.emit({ type: 'branch', data: state });
    }

    if (mod === 'tree' && name === 'TreeCreated') {
      const ev = json as unknown as TreeCreatedEvent;
      if (ev.tree_id !== this.treeId) return;
      // Seed the default branch (BranchCreated is not emitted for the default branch).
      const hex = ev.tree_id.startsWith('0x') ? ev.tree_id.slice(2) : ev.tree_id;
      const ns = `memforks/${hex}/${ev.default_branch}`;
      if (!this.branches.has(ev.default_branch)) {
        this.branches.set(ev.default_branch, {
          branch: ev.default_branch,
          namespace: ns,
          headBlobId: '',
          fromBranch: '',
        });
      }
      this.emit({ type: 'tree_created', data: ev });
    }

    if (mod === 'resolver' && name === 'MergeFinalized') {
      const ev = json as unknown as MergeFinalizedEvent & {
        from_head_blob_id?: string;
        into_head_blob_id?: string;
      };
      if (ev.tree_id !== this.treeId) return;

      const anchor: MergeAnchor = {
        proposalId: ev.proposal_id,
        treeId: ev.tree_id,
        intoBranch: '',
        mergeCommitId: ev.merge_commit_id,
        resolvedBlobId: ev.resolved_blob_id,
        fromHeadBlobId: ev.from_head_blob_id ?? '',
        intoHeadBlobId: ev.into_head_blob_id ?? '',
        indexedAt: Date.now(),
      };

      for (const [branch, state] of this.branches) {
        if (state.headBlobId === anchor.intoHeadBlobId) {
          state.headBlobId = anchor.resolvedBlobId;
          anchor.intoBranch = branch;
          break;
        }
      }

      this.merges.push(anchor);
      this.emit({ type: 'merge_finalized', data: anchor });
    }
  }
}
