/**
 * @memfork/core — canonical TypeScript types.
 *
 * Model A (SPEC §4–9): commits are off-chain Walrus blobs. MemoryCommit objects
 * are minted only for merge anchors and genesis. Branch heads are Walrus blob IDs.
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

export const PAYLOAD_VERSION = 1 as const;

export interface CommitDelta {
  messages?: Array<{ role: string; content: string }>;
  facts?: string[];
  embeddings_hint?: number[];
  files?: Array<{ path: string; blob: Uint8Array }>;
}

/**
 * Off-chain commit payload stored as a MemWal blob on Walrus (SPEC §8).
 *
 * The hash chain is formed by `parent_blob_hashes`: each commit stores
 * SHA-256(JSON.stringify(parent_payload)) for each parent, creating a
 * content-addressed chain verifiable from any merge anchor blob ID.
 */
export interface CommitPayload {
  v: typeof PAYLOAD_VERSION;
  type: "commit";
  /** Tree object ID as raw bytes. */
  tree: Uint8Array;
  branch: string;
  /** Author Sui address as raw bytes. */
  author: Uint8Array;
  ts_ms: number;
  /** Walrus blob IDs of parent commits. Empty for the first commit on a branch. */
  parent_blob_ids: string[];
  /**
   * SHA-256 of the JSON-serialised payload string of each parent commit.
   * Parallel to parent_blob_ids. Forms the verifiable content-addressed chain.
   * Empty for the first commit on a branch.
   */
  parent_blob_hashes: string[];
  delta: CommitDelta;
  extensions?: Record<string, unknown>;
}

// ─── On-chain object shapes ───────────────────────────────────────────────────

export interface OnChainTree {
  id: string;
  owner: string;
  memwal_account: string;
  /** branch name → settled head Walrus blob ID (hex-encoded). Empty string = at genesis. */
  branches: Record<string, string>;
  default_branch: string;
  /** Incremented only at merge time. */
  commit_count: string;
  created_at_ms: string;
}

/** On-chain merge anchor (not created for regular commits). */
export interface OnChainCommit {
  id: string;
  tree_id: string;
  /** Walrus blob IDs of the two branch heads consumed by this merge. Empty for genesis. */
  parents: string[];
  memwal_namespace: string;
  /** Walrus blob ID of this merge anchor's resolved content. */
  memwal_blob_id: string;
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
  payload: string;
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
  config: string;
}

export interface OnChainMergeProposal {
  id: string;
  tree_id: string;
  from_branch: string;
  into_branch: string;
  /** Walrus blob ID (hex) of from_branch tip when this proposal was opened. */
  from_head: string;
  /** Walrus blob ID (hex) of into_branch tip when this proposal was opened. */
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

/** MergeProposed carries the branch-tip blob IDs so indexers can walk the chain. */
export interface MergeProposedEvent {
  tree_id: string;
  proposal_id: string;
  from_branch: string;
  into_branch: string;
  from_head_blob_id: string;
  into_head_blob_id: string;
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
  /** On-chain MemoryCommit object ID (audit anchor). */
  merge_commit_id: string;
  /** Walrus blob ID the into_branch head was advanced to. */
  resolved_blob_id: string;
}

export interface MergeAbortedEvent {
  proposal_id: string;
  reason_code: number;
}

export interface MergeExpiredEvent {
  proposal_id: string;
}

// ─── SDK config (DX.md §1.2) ─────────────────────────────────────────────────

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
  k?: number;
  n?: number;
  judges?: string[];
  model?: string;
  promptCid?: string;
}

// ─── Namespace helper (SPEC §4.5) ────────────────────────────────────────────

export function branchNamespace(treeId: string, branch: string): string {
  const hex = treeId.startsWith("0x") ? treeId.slice(2) : treeId;
  return `memforks/${hex}/${branch}`;
}
