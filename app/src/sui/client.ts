/**
 * Thin wrapper around @mysten/sui SuiClient for MemForks event polling.
 *
 * Config resolution order:
 *   1. GET /api/config  — served by `memfork ui` local server (has credentials)
 *   2. URL params       — ?tree=0x…&network=testnet  (Walrus Site / sharing)
 *   3. Vite env vars    — baked in at build time (development fallback)
 *   4. Hardcoded demo defaults
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

const DEFAULT_PACKAGE_ID =
  import.meta.env.VITE_PACKAGE_ID ??
  "0x080722f5b7025679aa17792a3b07ef9b875b4ad3cee7640ecf9b8b7abd5b5347";

const DEFAULT_TREE_ID =
  import.meta.env.VITE_TREE_ID ??
  "0xeb88a31b9ef8c015e0182929c6b499126e176939ccfe5fd419dd8e1b35bea93c";

const DEFAULT_RPC =
  import.meta.env.VITE_SUI_RPC ?? "https://fullnode.testnet.sui.io:443";

export const WALRUS_BLOB_BASE =
  import.meta.env.VITE_WALRUS_BLOB_BASE ??
  "https://aggregator.walrus-testnet.walrus.space/v1/blobs";

export const SUI_EXPLORER_BASE = "https://suiscan.xyz/testnet/tx";

// ─── Runtime config (mutable, loaded by loadConfig()) ────────────────────────

export interface RuntimeConfig {
  treeId:    string;
  packageId: string;
  network:   string;
  rpcUrl:    string;
  hasMemwal: boolean;
}

// ─── Typed event parsers ──────────────────────────────────────────────────────

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

// ─── Polling client ───────────────────────────────────────────────────────────

export type MemForksEventHandlers = {
  onCommit?:       (e: CommitCreatedEvent)        => void;
  onBranch?:       (e: BranchCreatedEvent)        => void;
  onProposed?:     (e: MergeProposedEvent)        => void;
  onAttestation?:  (e: AttestationSubmittedEvent) => void;
  onFinalized?:    (e: MergeFinalizedEvent)       => void;
  onAborted?:      (e: MergeAbortedEvent)         => void;
};

export class MemForksClient {
  treeId    = DEFAULT_TREE_ID;
  packageId = DEFAULT_PACKAGE_ID;
  network   = "testnet";
  hasMemwal = false;

  private sui: SuiClient;
  private cursors: Map<string, EventId | null> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private handlers: MemForksEventHandlers = {};

  constructor() {
    this.sui = this.makeSuiClient(DEFAULT_RPC);
  }

  private makeSuiClient(rpc: string): SuiClient {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new SuiClient({ transport: new JsonRpcHTTPTransport({ url: rpc }), network: "testnet" } as any);
  }

  /**
   * Resolve runtime config from the local `memfork ui` server first,
   * then fall back to URL params, then Vite env vars / hardcoded defaults.
   *
   * Always resolves — never throws.
   */
  async loadConfig(): Promise<RuntimeConfig> {
    // ── 1. Local server (/api/config served by `memfork ui`) ──────────────
    try {
      const r = await fetch("/api/config", {
        signal: AbortSignal.timeout(1_500),
      });
      if (r.ok) {
        const cfg = await r.json() as Partial<RuntimeConfig>;
        if (cfg.treeId)    this.treeId    = cfg.treeId;
        if (cfg.packageId) this.packageId = cfg.packageId;
        if (cfg.network)   this.network   = cfg.network;
        if (cfg.hasMemwal) this.hasMemwal = cfg.hasMemwal;
        if ((cfg as Record<string, unknown>)["rpcUrl"]) {
          this.sui = this.makeSuiClient(String((cfg as Record<string, unknown>)["rpcUrl"]));
        }
        return this.currentConfig();
      }
    } catch { /* not running via local server */ }

    // ── 2. URL params (Walrus Site or manual sharing) ─────────────────────
    const params = new URLSearchParams(window.location.search);
    if (params.get("tree"))    this.treeId    = params.get("tree")!;
    if (params.get("package")) this.packageId = params.get("package")!;
    if (params.get("network")) this.network   = params.get("network")!;

    // ── 3. Fall through to Vite env / hardcoded defaults (no change needed)
    return this.currentConfig();
  }

  private currentConfig(): RuntimeConfig {
    return {
      treeId:    this.treeId,
      packageId: this.packageId,
      network:   this.network,
      rpcUrl:    DEFAULT_RPC,
      hasMemwal: this.hasMemwal,
    };
  }

  setHandlers(h: MemForksEventHandlers) {
    this.handlers = h;
  }

  /** Fetch all historical events for the tree (initial load). */
  async fetchHistory(): Promise<void> {
    for (const type of this.eventTypes()) {
      await this.pollType(type, null, true);
    }
  }

  /** Start polling for new events every `intervalMs`. */
  startPolling(intervalMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const type of this.eventTypes()) {
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

  private eventTypes(): string[] {
    return [
      `${this.packageId}::tree::CommitCreated`,
      `${this.packageId}::tree::BranchCreated`,
      `${this.packageId}::resolver::MergeProposed`,
      `${this.packageId}::resolver::AttestationSubmitted`,
      `${this.packageId}::resolver::MergeFinalized`,
      `${this.packageId}::resolver::MergeAborted`,
    ];
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
        query: { MoveEventType: type },
        cursor: nextCursor ?? undefined,
        limit: 50,
        order: "ascending",
      });

      for (const e of result.data) {
        const parsed = e.parsedJson as Record<string, unknown>;
        if (parsed.tree_id !== this.treeId) continue;
        this.dispatch(type, e);
      }

      nextCursor = result.nextCursor ?? null;
      hasMore = result.hasNextPage && isHistory;
    }

    this.cursors.set(type, nextCursor);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private dispatch(type: string, e: any): void {
    if (type.endsWith("::CommitCreated"))          this.handlers.onCommit?.(parseCommit(e));
    else if (type.endsWith("::BranchCreated"))     this.handlers.onBranch?.(parseBranch(e));
    else if (type.endsWith("::MergeProposed"))     this.handlers.onProposed?.(parseMergeProposed(e));
    else if (type.endsWith("::AttestationSubmitted")) this.handlers.onAttestation?.(parseAttestation(e));
    else if (type.endsWith("::MergeFinalized"))    this.handlers.onFinalized?.(parseMergeFinalized(e));
    else if (type.endsWith("::MergeAborted"))      this.handlers.onAborted?.(parseMergeAborted(e));
  }
}

export const memForksClient = new MemForksClient();
