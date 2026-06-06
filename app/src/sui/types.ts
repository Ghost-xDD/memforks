// Wire types — mirrors on-chain event structs (SPEC §9, Model A).
//
// Model A: CommitCreated no longer exists. Regular commits are off-chain Walrus
// blobs. The DAG is reconstructed by walking the blob hash chain from MergeFinalized
// events (from_head_blob_id / into_head_blob_id → Walrus blob walk).

export type SuiObjectId = string; // 0x-prefixed hex
export type SuiAddress  = string; // 0x-prefixed hex
export type BlobId      = string; // Walrus blob ID (hex)

// ─── On-chain events ─────────────────────────────────────────────────────────

export interface BranchCreatedEvent {
  tree_id:          SuiObjectId;
  branch:           string;
  from_branch:      string;
  memwal_namespace: string;
  tx_digest:        string;
  ts_ms:            number;
}

export interface MergeProposedEvent {
  tree_id:             SuiObjectId;
  proposal_id:         SuiObjectId;
  from_branch:         string;
  into_branch:         string;
  resolver_id:         SuiObjectId;
  /** Walrus blob ID of from_branch tip at proposal time. */
  from_head_blob_id:   BlobId;
  /** Walrus blob ID of into_branch tip at proposal time. */
  into_head_blob_id:   BlobId;
  expires_at_ms:       number;
  ts_ms:               number;
  tx_digest:           string;
}

export interface AttestationSubmittedEvent {
  tree_id:     SuiObjectId;
  proposal_id: SuiObjectId;
  signer:      SuiAddress;
  kind:        number;
  ts_ms:       number;
  tx_digest:   string;
}

export interface MergeFinalizedEvent {
  tree_id:          SuiObjectId;
  proposal_id:      SuiObjectId;
  /** On-chain MemoryCommit anchor object ID. */
  merge_commit_id:  SuiObjectId;
  /** Walrus blob ID the into_branch head was advanced to. */
  resolved_blob_id: BlobId;
  ts_ms:            number;
  tx_digest:        string;
}

export interface MergeAbortedEvent {
  tree_id:     SuiObjectId;
  proposal_id: SuiObjectId;
  reason_code: number;
  ts_ms:       number;
  tx_digest:   string;
}

export interface TreeCreatedEvent {
  tree_id:          SuiObjectId;
  owner:            SuiAddress;
  memwal_account:   SuiObjectId;
  default_branch:   string;
  ts_ms:            number;
  tx_digest:        string;
}

// ─── App-level domain models ──────────────────────────────────────────────────

/**
 * On-chain merge anchor (MemoryCommit). Not created for regular commits.
 * parents are Walrus blob IDs of the two branch tips consumed by the merge.
 */
export interface MergeAnchor {
  id:               SuiObjectId;
  tree_id:          SuiObjectId;
  /** The into_branch name. */
  branch:           string;
  /** Walrus blob IDs of the from_head and into_head consumed by the merge. */
  parents:          BlobId[];
  memwal_namespace: string;
  /** Walrus blob ID of the resolved content. */
  resolved_blob_id: BlobId;
  author:           SuiAddress;
  proposal_id:      SuiObjectId;
  ts_ms:            number;
  tx_digest:        string;
}

export interface MemoryBranch {
  name:             string;
  from_branch:      string;
  memwal_namespace: string;
  /** Settled Walrus blob ID (last merge resolution). Empty = at genesis. */
  head_blob_id:     BlobId;
  ts_ms:            number;
}

export type ProposalStatus = "pending" | "finalized" | "aborted" | "expired";

export interface AttestationRecord {
  signer:      SuiAddress;
  kind:        number;
  tx_digest:   string;
  ts_ms:       number;
}

export interface MergeProposal {
  id:               SuiObjectId;
  tree_id:          SuiObjectId;
  from_branch:      string;
  into_branch:      string;
  /** Walrus blob IDs stored in the proposal for the fast-forward check. */
  from_head_blob_id: BlobId;
  into_head_blob_id: BlobId;
  resolver_id:      SuiObjectId;
  proposer:         SuiAddress;
  status:           ProposalStatus;
  attestations:     AttestationRecord[];
  merge_commit_id:  SuiObjectId | null;
  resolved_blob_id: BlobId | null;
  ts_ms:            number;
  tx_digest:        string;
}

// ─── Attestation kind labels ──────────────────────────────────────────────────

export const ATTEST_KIND: Record<number, string> = {
  0x01: "JURY_VOTE",
  0x02: "EVALUATOR",
  0x03: "ORACLE",
  0x04: "LLM_RESOLVE",
};
