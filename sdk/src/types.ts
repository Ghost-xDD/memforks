/**
 * @memfork/core — canonical TypeScript types.
 *
 * This file is the Phase 0 contract shape (SPEC §3–10).
 * It is the source of truth for the SDK, adapters, and CLI.
 * Any change here MUST be reflected in the Move package constants and events.
 */

// ─── Permission bitmask (SPEC §3.1) ──────────────────────────────────────────

export const PERM = {
  READ:    0x01,
  WRITE:   0x02,
  FORK:    0x04,
  MERGE:   0x08,
  PROPOSE: 0x10,
} as const satisfies Record<string, number>;

export type PermFlags = number;

/** All permissions (convenience constant for owner-level delegates). */
export const PERM_ALL: PermFlags =
  PERM.READ | PERM.WRITE | PERM.FORK | PERM.MERGE | PERM.PROPOSE;

// ─── Resolver kinds (SPEC §4.6) ──────────────────────────────────────────────

export const RESOLVER_KIND = {
  LAST_WRITE_WINS: 0x00,
  UNION:           0x01,
  LLM_RECONCILE:  0x02,
  JURY_RECONCILE: 0x03,
  EVALUATOR_PICK: 0x04,
  AND:            0x05,
  SEQUENCE:       0x06,
} as const satisfies Record<string, number>;

export type ResolverKind = typeof RESOLVER_KIND[keyof typeof RESOLVER_KIND];

// ─── Attestation kinds (SPEC §4.4) ───────────────────────────────────────────

export const ATTEST_KIND = {
  JURY_VOTE:          0x01,
  EVALUATOR_VERDICT:  0x02,
  ORACLE_REPORT:      0x03,
  LLM_RESOLVE:        0x04,
} as const satisfies Record<string, number>;

export type AttestKind = typeof ATTEST_KIND[keyof typeof ATTEST_KIND];

// ─── Proposal status (SPEC §4.7) ─────────────────────────────────────────────

export const PROPOSAL_STATUS = {
  PENDING:   0,
  FINALIZED: 1,
  ABORTED:   2,
  EXPIRED:   3,
} as const satisfies Record<string, number>;

export type ProposalStatus = typeof PROPOSAL_STATUS[keyof typeof PROPOSAL_STATUS];

// ─── Error codes (SPEC §10) ──────────────────────────────────────────────────

export const ERROR_CODE = {
  E_NOT_OWNER:              0x0001,
  E_NOT_DELEGATE:           0x0002,
  E_DELEGATE_REVOKED:       0x0003,
  E_DELEGATE_EXPIRED:       0x0004,
  E_MISSING_PERMISSION:     0x0005,
  E_BRANCH_NOT_FOUND:       0x0006,
  E_BRANCH_EXISTS:          0x0007,
  E_BRANCH_OUT_OF_SCOPE:    0x0008,
  E_INVALID_PARENTS:        0x0009,
  E_RESERVED_BITS_SET:      0x000A,
  E_PROPOSAL_NOT_PENDING:   0x0010,
  E_PROPOSAL_NOT_EXPIRED:   0x0011,
  E_FAST_FORWARD_CONFLICT:  0x0012,
  E_RESOLVER_REJECT:        0x0013,
  E_RESOLVER_PENDING:       0x0014,
  E_RESOLVER_INCOMPATIBLE:  0x0015,
  E_ATTESTATION_INVALID:    0x0016,
  E_COMPOSITION_LIMIT:      0x0017,
  E_PAYLOAD_VERSION_UNKNOWN: 0x0020,
} as const satisfies Record<string, number>;

// ─── Commit payload wire format (SPEC §8) ────────────────────────────────────

/** CBOR payload version — increment on breaking schema changes. */
export const PAYLOAD_VERSION = 1;

export interface CommitDelta {
  /** Conversation turns, framework-defined. */
  messages?: Array<{ role: string; content: string }>;
  /** Atomic extracted facts for semantic recall. */
  facts?: string[];
  /** Pre-computed embedding vectors (optional hint for the relayer). */
  embeddings_hint?: number[];
  /**
   * Agent-generated artifacts (datasets, diffs, reports).
   * Each blob is stored on Walrus via MemWal and retrievable from the inspector.
   */
  files?: Array<{ path: string; blob: Uint8Array }>;
}

/** Wire format stored encrypted on Walrus via MemWal. (SPEC §8) */
export interface CommitPayload {
  /** Schema version. MUST be 1 for this spec. */
  v: typeof PAYLOAD_VERSION;
  /** Tree object ID as raw bytes. */
  tree: Uint8Array;
  /** Parent commit IDs as raw bytes. Empty only for the genesis commit. */
  parents: Uint8Array[];
  branch: string;
  /** Author address as raw bytes. */
  author: Uint8Array;
  ts_ms: number;
  delta: CommitDelta;
  /** Application-defined extensions. Namespaced to avoid collisions. */
  extensions?: Record<string, unknown>;
}

// ─── On-chain object shapes (read from Sui) ───────────────────────────────────

export interface OnChainTree {
  id: string;
  owner: string;
  memwal_account: string;
  branches: Record<string, string>;   // branch name → head commit ID
  default_branch: string;
  commit_count: string;               // u64 as string
  created_at_ms: string;
}

export interface OnChainCommit {
  id: string;
  tree_id: string;
  parents: string[];
  memwal_namespace: string;
  memwal_blob_id: string;             // hex-encoded bytes
  author: string;
  author_branch: string;
  message: string;
  merge_resolver: string | null;
  attestations: OnChainAttestation[];
  epoch: string;
  ts_ms: string;
}

export interface OnChainAttestation {
  signer: string;
  kind: number;
  payload: string;                    // hex-encoded bytes
}

export interface OnChainDelegateCap {
  agent: string;
  allowed_branches: string[];
  permissions: number;
  expires_epoch: string;
  revoked: boolean;
}

export interface OnChainBranchACL {
  id: string;
  tree_id: string;
  branch: string;
  memwal_namespace: string;
  merge_authority: string | null;
}

export interface OnChainResolverRef {
  id: string;
  kind: number;
  config: string;                     // hex-encoded CBOR bytes
}

export interface OnChainMergeProposal {
  id: string;
  tree_id: string;
  from_branch: string;
  into_branch: string;
  from_head: string;
  into_head: string;
  resolver: string;
  proposed_by: string;
  proposed_at_ms: string;
  expires_at_ms: string;
  status: ProposalStatus;
  resolved_memwal_namespace: string | null;
  resolved_memwal_blob_id: string | null;
  attestations: OnChainAttestation[];
}

// ─── Event types (SPEC §9) ────────────────────────────────────────────────────

export interface TreeCreatedEvent {
  tree_id: string;
  owner: string;
  memwal_account: string;
  default_branch: string;
  ts_ms: string;
}

export interface DelegateGrantedEvent {
  tree_id: string;
  agent: string;
  permissions: number;
  expires_epoch: string;
}

export interface DelegateRevokedEvent {
  tree_id: string;
  agent: string;
}

export interface BranchCreatedEvent {
  tree_id: string;
  branch: string;
  from_branch: string;
  memwal_namespace: string;
}

export interface CommitCreatedEvent {
  tree_id: string;
  commit_id: string;
  branch: string;
  parents: string[];
  memwal_namespace: string;
  memwal_blob_id: string;
  author: string;
  is_merge: boolean;
}

export interface MergeProposedEvent {
  tree_id: string;
  proposal_id: string;
  from_branch: string;
  into_branch: string;
  resolver_id: string;
  expires_at_ms: string;
}

export interface AttestationSubmittedEvent {
  proposal_id: string;
  signer: string;
  kind: number;
}

export interface MergeFinalizedEvent {
  tree_id: string;
  proposal_id: string;
  merge_commit_id: string;
}

export interface MergeAbortedEvent {
  proposal_id: string;
  reason_code: number;
}

export interface MergeExpiredEvent {
  proposal_id: string;
}

// ─── SDK config (DX.md §1.2) ─────────────────────────────────────────────────

/** Contents of .memforks.json — safe to commit. */
export interface MemForksConfig {
  treeId: string;
  defaultBranch: string;
  autoSync: boolean;
  commitOn: "remember" | "manual";
  resolvers?: Record<string, ResolverConfig>;
  relayer: string;
}

export interface ResolverConfig {
  kind: keyof typeof RESOLVER_KIND;
  /** For JURY_RECONCILE */
  k?: number;
  n?: number;
  judges?: string[];
  /** For LLM_RECONCILE */
  model?: string;
  promptCid?: string;
}

// ─── Namespace helper (SPEC §4.5) ────────────────────────────────────────────

/**
 * Derive the MemWal namespace for a branch.
 * Format: memforks/<tree_id_hex>/<branch>
 *
 * @param treeId - the 0x-prefixed tree object ID string
 * @param branch - branch name
 */
export function branchNamespace(treeId: string, branch: string): string {
  const hex = treeId.startsWith("0x") ? treeId.slice(2) : treeId;
  return `memforks/${hex}/${branch}`;
}
