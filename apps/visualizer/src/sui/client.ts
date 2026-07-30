/**
 * Thin polling wrapper for the MemForks UI.
 *
 * Model A: CommitCreated events no longer exist. The event set is:
 *   tree::BranchCreated
 *   resolver::MergeProposed
 *   resolver::AttestationSubmitted
 *   resolver::MergeFinalized
 *   resolver::MergeAborted
 *
 * Chain access: gRPC for object reads, GraphQL for event polling
 * (JSON-RPC is disabled on Foundation fullnodes as of 2026-07).
 *
 * Config resolution order:
 *   1. GET /api/config  — served by `memfork ui` local server (has credentials)
 *   2. URL params       — ?tree=0x…&network=testnet  (Walrus Site / sharing)
 *   3. Vite env vars    — baked in at build time (development fallback)
 *   4. Hardcoded demo defaults
 */

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import type {
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
  "0x099bb03595562bd4fdcb84dc60a330563ee55ca6d7b0808f048e1741795bc5be";

const DEFAULT_RPC =
  import.meta.env.VITE_SUI_RPC ?? "https://fullnode.testnet.sui.io:443";

const RPC_BY_NETWORK: Record<string, string> = {
  mainnet: "https://fullnode.mainnet.sui.io:443",
  testnet: "https://fullnode.testnet.sui.io:443",
};

const GRAPHQL_BY_NETWORK: Record<string, string> = {
  mainnet: "https://graphql.mainnet.sui.io/graphql",
  testnet: "https://graphql.testnet.sui.io/graphql",
};

const EXPLORER_BY_NETWORK: Record<string, string> = {
  mainnet: "https://suiscan.xyz/mainnet/tx",
  testnet: "https://suiscan.xyz/testnet/tx",
};

export const WALRUS_BLOB_BASE =
  import.meta.env.VITE_WALRUS_BLOB_BASE ??
  "https://aggregator.walrus-testnet.walrus.space/v1/blobs";

const WALRUS_BLOB_BY_NETWORK: Record<string, string> = {
  mainnet: "https://aggregator.walrus-mainnet.walrus.space/v1/blobs",
  testnet: "https://aggregator.walrus-testnet.walrus.space/v1/blobs",
};

let _walrusBlobBase = WALRUS_BLOB_BASE;
export function getWalrusBlobBase(): string {
  return _walrusBlobBase;
}

let _suiExplorerBase = "https://suiscan.xyz/testnet/tx";
export function getSuiExplorerBase(): string {
  return _suiExplorerBase;
}
export let SUI_EXPLORER_BASE = _suiExplorerBase;

export interface RuntimeConfig {
  treeId: string;
  packageId: string;
  network: string;
  rpcUrl: string;
  hasMemwal: boolean;
}

type GraphQLEventNode = {
  contents?: { json?: Record<string, unknown> };
  timestamp?: string | null;
  transactionBlock?: { digest?: string };
};

function asEventEnvelope(node: GraphQLEventNode) {
  return {
    parsedJson: node.contents?.json ?? {},
    id: { txDigest: node.transactionBlock?.digest ?? "" },
    timestampMs: node.timestamp ? String(Date.parse(node.timestamp) || Date.now()) : String(Date.now()),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseBranch(e: any): BranchCreatedEvent {
  const p = e.parsedJson;
  return {
    tree_id: p.tree_id,
    branch: p.branch,
    from_branch: p.from_branch,
    memwal_namespace: p.memwal_namespace,
    tx_digest: e.id.txDigest,
    ts_ms: Number(e.timestampMs ?? Date.now()),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseMergeProposed(e: any): MergeProposedEvent {
  const p = e.parsedJson;
  return {
    tree_id: p.tree_id,
    proposal_id: p.proposal_id,
    from_branch: p.from_branch,
    into_branch: p.into_branch,
    resolver_id: p.resolver_id,
    from_head_blob_id: decodeBlobIdField(p.from_head_blob_id),
    into_head_blob_id: decodeBlobIdField(p.into_head_blob_id),
    expires_at_ms: Number(p.expires_at_ms ?? 0),
    ts_ms: Number(e.timestampMs ?? Date.now()),
    tx_digest: e.id.txDigest,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseAttestation(e: any): AttestationSubmittedEvent {
  const p = e.parsedJson;
  let vote: string | undefined;
  try {
    const raw = p.payload as number[] | string | undefined;
    if (raw) {
      let bytes: Uint8Array;
      if (Array.isArray(raw)) {
        bytes = new Uint8Array(raw as number[]);
      } else {
        const hex = (raw as string).startsWith("0x")
          ? (raw as string).slice(2)
          : (raw as string);
        bytes = new Uint8Array(
          hex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? [],
        );
      }
      const decoded = JSON.parse(
        new TextDecoder().decode(bytes),
      ) as Record<string, unknown>;
      vote = decoded["vote"] as string | undefined;
    }
  } catch {
    /* payload not present or malformed */
  }

  return {
    tree_id: p.tree_id,
    proposal_id: p.proposal_id,
    signer: p.signer,
    kind: Number(p.kind),
    ts_ms: Number(e.timestampMs ?? Date.now()),
    tx_digest: e.id.txDigest,
    ...(vote !== undefined && { vote }),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseMergeFinalized(e: any): MergeFinalizedEvent {
  const p = e.parsedJson;
  return {
    tree_id: p.tree_id,
    proposal_id: p.proposal_id,
    merge_commit_id: p.merge_commit_id,
    resolved_blob_id: decodeBlobIdField(p.resolved_blob_id),
    ts_ms: Number(e.timestampMs ?? Date.now()),
    tx_digest: e.id.txDigest,
  };
}

function decodeBlobIdField(raw: unknown): string {
  if (!raw) return "";
  if (Array.isArray(raw)) {
    if (raw.length === 0) return "";
    return new TextDecoder().decode(new Uint8Array(raw as number[]));
  }
  if (typeof raw === "string") return raw;
  return "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseMergeAborted(e: any): MergeAbortedEvent {
  const p = e.parsedJson;
  return {
    tree_id: p.tree_id,
    proposal_id: p.proposal_id,
    reason_code: Number(p.reason_code ?? 0),
    ts_ms: Number(e.timestampMs ?? Date.now()),
    tx_digest: e.id.txDigest,
  };
}

export type MemForksEventHandlers = {
  onBranch?: (e: BranchCreatedEvent) => void;
  onProposed?: (e: MergeProposedEvent) => void;
  onAttestation?: (e: AttestationSubmittedEvent) => void;
  onFinalized?: (e: MergeFinalizedEvent) => void;
  onAborted?: (e: MergeAbortedEvent) => void;
};

export class MemForksClient {
  treeId = DEFAULT_TREE_ID;
  packageId = DEFAULT_PACKAGE_ID;
  network = "testnet";
  hasMemwal = false;

  private sui: SuiGrpcClient;
  private graphql: SuiGraphQLClient;
  private cursors: Map<string, string | null> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private handlers: MemForksEventHandlers = {};
  private rpcUrl = DEFAULT_RPC;

  constructor() {
    this.sui = this.makeSuiClient(DEFAULT_RPC, "testnet");
    this.graphql = this.makeGraphql("testnet");
  }

  private makeSuiClient(rpc: string, network: string): SuiGrpcClient {
    return new SuiGrpcClient({
      network: network as "mainnet" | "testnet",
      baseUrl: rpc,
    });
  }

  private makeGraphql(network: string): SuiGraphQLClient {
    return new SuiGraphQLClient({
      network: network as "mainnet" | "testnet",
      url: GRAPHQL_BY_NETWORK[network] ?? GRAPHQL_BY_NETWORK["testnet"]!,
    });
  }

  async loadConfig(): Promise<RuntimeConfig> {
    try {
      const r = await fetch("/api/config", {
        signal: AbortSignal.timeout(1_500),
      });
      if (r.ok) {
        const cfg = (await r.json()) as Partial<RuntimeConfig>;
        if (cfg.treeId) this.treeId = cfg.treeId;
        if (cfg.packageId) this.packageId = cfg.packageId;
        if (cfg.network) this.network = cfg.network;
        if (cfg.hasMemwal) this.hasMemwal = cfg.hasMemwal;

        const explicitRpc = (cfg as Record<string, unknown>)["rpcUrl"] as
          | string
          | null
          | undefined;
        this.rpcUrl =
          explicitRpc || RPC_BY_NETWORK[this.network] || DEFAULT_RPC;
        this.sui = this.makeSuiClient(this.rpcUrl, this.network);
        this.graphql = this.makeGraphql(this.network);

        SUI_EXPLORER_BASE =
          EXPLORER_BY_NETWORK[this.network] ?? SUI_EXPLORER_BASE;
        _suiExplorerBase = SUI_EXPLORER_BASE;
        _walrusBlobBase =
          WALRUS_BLOB_BY_NETWORK[this.network] ?? _walrusBlobBase;

        return this.currentConfig();
      }
    } catch {
      /* not running via local server */
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get("tree")) this.treeId = params.get("tree")!;
    if (params.get("package")) this.packageId = params.get("package")!;
    if (params.get("network")) {
      this.network = params.get("network")!;
      this.rpcUrl = RPC_BY_NETWORK[this.network] || DEFAULT_RPC;
      this.sui = this.makeSuiClient(this.rpcUrl, this.network);
      this.graphql = this.makeGraphql(this.network);
    }

    return this.currentConfig();
  }

  private currentConfig(): RuntimeConfig {
    return {
      treeId: this.treeId,
      packageId: this.packageId,
      network: this.network,
      rpcUrl: this.rpcUrl,
      hasMemwal: this.hasMemwal,
    };
  }

  setHandlers(h: MemForksEventHandlers) {
    this.handlers = h;
  }

  async fetchHistory(): Promise<void> {
    for (const type of this.eventTypes()) {
      await this.pollType(type, null, true);
    }
  }

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

  async fetchResolverInfo(resolverId: string): Promise<{
    kind: number;
    config: Uint8Array;
  } | null> {
    try {
      const { object } = await this.sui.getObject({
        objectId: resolverId,
        include: { json: true },
      });
      if (!object.json) return null;
      const fields = object.json;
      const kind = Number(fields["kind"] ?? -1);
      const raw = fields["config"];
      let config: Uint8Array;
      if (Array.isArray(raw)) {
        config = new Uint8Array(raw as number[]);
      } else if (typeof raw === "string") {
        const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
        config = new Uint8Array(
          hex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? [],
        );
      } else {
        config = new Uint8Array();
      }
      return { kind, config };
    } catch {
      return null;
    }
  }

  private eventTypes(): string[] {
    return [
      `${this.packageId}::tree::BranchCreated`,
      `${this.packageId}::resolver::MergeProposed`,
      `${this.packageId}::resolver::AttestationSubmitted`,
      `${this.packageId}::resolver::MergeFinalized`,
      `${this.packageId}::resolver::MergeAborted`,
    ];
  }

  private async pollType(
    type: string,
    cursor: string | null,
    isHistory: boolean,
  ): Promise<void> {
    let after: string | null = cursor;
    let hasMore = true;

    while (hasMore) {
      const result = await this.graphql.query({
        query: `query ($type: String!, $after: String) {
          events(filter: { type: $type }, first: 50, after: $after) {
            pageInfo { endCursor hasNextPage }
            nodes {
              contents { json }
              timestamp
              transactionBlock { digest }
            }
          }
        }`,
        variables: { type, after },
      });

      const events = (
        result.data as {
          events?: {
            pageInfo?: { endCursor?: string | null; hasNextPage?: boolean };
            nodes?: GraphQLEventNode[];
          };
        }
      )?.events;

      for (const node of events?.nodes ?? []) {
        const e = asEventEnvelope(node);
        const parsed = e.parsedJson;
        if (
          parsed["tree_id"] !== undefined &&
          parsed["tree_id"] !== this.treeId
        )
          continue;
        this.dispatch(type, e);
      }

      after = events?.pageInfo?.endCursor ?? null;
      hasMore = Boolean(events?.pageInfo?.hasNextPage && isHistory && after);
    }

    this.cursors.set(type, after);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private dispatch(type: string, e: any): void {
    if (type.endsWith("::BranchCreated"))
      this.handlers.onBranch?.(parseBranch(e));
    else if (type.endsWith("::MergeProposed"))
      this.handlers.onProposed?.(parseMergeProposed(e));
    else if (type.endsWith("::AttestationSubmitted"))
      this.handlers.onAttestation?.(parseAttestation(e));
    else if (type.endsWith("::MergeFinalized"))
      this.handlers.onFinalized?.(parseMergeFinalized(e));
    else if (type.endsWith("::MergeAborted"))
      this.handlers.onAborted?.(parseMergeAborted(e));
  }
}

export const memForksClient = new MemForksClient();
