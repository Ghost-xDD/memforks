/**
 * Thin wrapper around @mysten/sui SuiClient for MemForks event polling.
 *
 * Polls the five event types emitted by the MemForks Move package and
 * calls registered handlers on each new event.  Keeps a cursor so it
 * resumes cleanly after a page reload.
 */

import { SuiJsonRpcClient as SuiClient, JsonRpcHTTPTransport } from "@mysten/sui/jsonRpc";
import type { EventId } from "@mysten/sui/jsonRpc";
import type {
  CommitCreatedEvent,
  BranchCreatedEvent,
  MergeProposedEvent,
  AttestationSubmittedEvent,
  MergeFinalizedEvent,
  MergeAbortedEvent,
} from "./types.js";

export const PACKAGE_ID =
  import.meta.env.VITE_PACKAGE_ID ??
  "0xc9f0a4964f810c794479bc5b66347998969d2c59d6797c313b8a96d2bdd6a914";

export const TREE_ID =
  import.meta.env.VITE_TREE_ID ??
  "0xeb88a31b9ef8c015e0182929c6b499126e176939ccfe5fd419dd8e1b35bea93c";

export const SUI_RPC =
  import.meta.env.VITE_SUI_RPC ?? "https://fullnode.testnet.sui.io:443";

export const WALRUS_BLOB_BASE =
  import.meta.env.VITE_WALRUS_BLOB_BASE ?? "https://aggregator.walrus-testnet.walrus.space/v1/blobs";

export const SUI_EXPLORER_BASE =
  "https://suiscan.xyz/testnet/tx";

// ─── Typed event parsers ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseCommit(e: any): CommitCreatedEvent {
  const p = e.parsedJson;
  return {
    tree_id:          p.tree_id,
    commit_id:        p.commit_id,
    branch:           p.branch,
    parents:          (p.parents ?? []) as string[],
    memwal_namespace: p.memwal_namespace,
    memwal_blob_id:   p.memwal_blob_id,
    author:           p.author,
    is_merge:         !!p.is_merge,
    ts_ms:            Number(e.timestampMs ?? Date.now()),
    tx_digest:        e.id.txDigest,
    seq:              String(e.id.eventSeq ?? 0),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseBranch(e: any): BranchCreatedEvent {
  const p = e.parsedJson;
  return {
    tree_id:          p.tree_id,
    branch:           p.branch,
    from_branch:      p.from_branch,
    memwal_namespace: p.memwal_namespace,
    tx_digest:        e.id.txDigest,
    ts_ms:            Number(e.timestampMs ?? Date.now()),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseMergeProposed(e: any): MergeProposedEvent {
  const p = e.parsedJson;
  return {
    tree_id:     p.tree_id,
    proposal_id: p.proposal_id,
    from_branch: p.from_branch,
    into_branch: p.into_branch,
    resolver_id: p.resolver_id,
    ttl_ms:      Number(p.ttl_ms ?? 0),
    proposer:    p.proposer,
    ts_ms:       Number(e.timestampMs ?? Date.now()),
    tx_digest:   e.id.txDigest,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseAttestation(e: any): AttestationSubmittedEvent {
  const p = e.parsedJson;
  return {
    tree_id:     p.tree_id,
    proposal_id: p.proposal_id,
    signer:      p.signer,
    kind:        Number(p.kind),
    ts_ms:       Number(e.timestampMs ?? Date.now()),
    tx_digest:   e.id.txDigest,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseMergeFinalized(e: any): MergeFinalizedEvent {
  const p = e.parsedJson;
  return {
    tree_id:     p.tree_id,
    proposal_id: p.proposal_id,
    commit_id:   p.commit_id,
    verdict:     p.verdict ?? "APPROVE",
    ts_ms:       Number(e.timestampMs ?? Date.now()),
    tx_digest:   e.id.txDigest,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseMergeAborted(e: any): MergeAbortedEvent {
  const p = e.parsedJson;
  return {
    tree_id:     p.tree_id,
    proposal_id: p.proposal_id,
    ts_ms:       Number(e.timestampMs ?? Date.now()),
    tx_digest:   e.id.txDigest,
  };
}

// ─── Polling client ──────────────────────────────────────────────────────────

export type MemForksEventHandlers = {
  onCommit?:       (e: CommitCreatedEvent)       => void;
  onBranch?:       (e: BranchCreatedEvent)       => void;
  onProposed?:     (e: MergeProposedEvent)       => void;
  onAttestation?:  (e: AttestationSubmittedEvent) => void;
  onFinalized?:    (e: MergeFinalizedEvent)       => void;
  onAborted?:      (e: MergeAbortedEvent)         => void;
};

const EVENT_TYPES = [
  `${PACKAGE_ID}::tree::CommitCreated`,
  `${PACKAGE_ID}::tree::BranchCreated`,
  `${PACKAGE_ID}::resolver::MergeProposed`,
  `${PACKAGE_ID}::resolver::AttestationSubmitted`,
  `${PACKAGE_ID}::resolver::MergeFinalized`,
  `${PACKAGE_ID}::resolver::MergeAborted`,
] as const;

export class MemForksClient {
  private readonly sui: SuiClient;
  private cursors: Map<string, EventId | null> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private handlers: MemForksEventHandlers = {};

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.sui = new SuiClient({ transport: new JsonRpcHTTPTransport({ url: SUI_RPC }), network: "testnet" } as any);
  }

  setHandlers(h: MemForksEventHandlers) {
    this.handlers = h;
  }

  /** Fetch all historical events for the tree (initial load). */
  async fetchHistory(): Promise<void> {
    for (const type of EVENT_TYPES) {
      await this.pollType(type, null, true);
    }
  }

  /** Start polling for new events every `intervalMs`. */
  startPolling(intervalMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const type of EVENT_TYPES) {
        this.pollType(type, this.cursors.get(type) ?? null, false).catch(
          (err) => console.warn("[memforks] poll error:", err),
        );
      }
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async pollType(
    type: string,
    cursor: EventId | null,
    isHistory: boolean,
  ): Promise<void> {
    let nextCursor: EventId | null = cursor;
    let hasMore = true;

    while (hasMore) {
      const result = await this.sui.queryEvents({
        query: {
          MoveEventType: type,
          // Filter by tree_id when the RPC supports it — for now fetch all
          // and filter client-side.
        },
        cursor: nextCursor ?? undefined,
        limit: 50,
        order: "ascending",
      });

      for (const e of result.data) {
        const parsed = e.parsedJson as Record<string, unknown>;
        // Filter to this tree only.
        if (parsed.tree_id !== TREE_ID) continue;
        this.dispatch(type, e);
      }

      nextCursor = result.nextCursor ?? null;
      hasMore = result.hasNextPage && isHistory;
    }

    this.cursors.set(type, nextCursor);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private dispatch(type: string, e: any): void {
    if (type.endsWith("::CommitCreated"))       this.handlers.onCommit?.(parseCommit(e));
    else if (type.endsWith("::BranchCreated"))  this.handlers.onBranch?.(parseBranch(e));
    else if (type.endsWith("::MergeProposed"))  this.handlers.onProposed?.(parseMergeProposed(e));
    else if (type.endsWith("::AttestationSubmitted")) this.handlers.onAttestation?.(parseAttestation(e));
    else if (type.endsWith("::MergeFinalized")) this.handlers.onFinalized?.(parseMergeFinalized(e));
    else if (type.endsWith("::MergeAborted"))   this.handlers.onAborted?.(parseMergeAborted(e));
  }
}

export const memForksClient = new MemForksClient();
