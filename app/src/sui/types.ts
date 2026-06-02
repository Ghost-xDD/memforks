// Wire types — mirrors the on-chain event structs in contracts/sources/tree.move
// and contracts/sources/resolver.move (SPEC §9).

export type SuiObjectId = string; // 0x-prefixed hex
export type SuiAddress  = string; // 0x-prefixed hex
export type BlobId      = string; // hex bytes from memwal_blob_id

// ─── On-chain events ─────────────────────────────────────────────────────────

export interface CommitCreatedEvent {
  tree_id:           SuiObjectId;
  commit_id:         SuiObjectId;
  branch:            string;
  parents:           SuiObjectId[];
  memwal_namespace:  string;
  memwal_blob_id:    BlobId;
  author:            SuiAddress;
  is_merge:          boolean;
  /** Populated from the enclosing SuiEvent wrapper. */
  ts_ms:             number;
  /** Sui digest of the transaction that emitted this event. */
  tx_digest:         string;
  /** Seq number within the event stream — used to order events from same tx. */
  seq:               string;
}

export interface BranchCreatedEvent {
  tree_id:          SuiObjectId;
  branch:           string;
  from_branch:      string;
  memwal_namespace: string;
  tx_digest:        string;
  ts_ms:            number;
}

export interface MergeProposedEvent {
  tree_id:      SuiObjectId;
  proposal_id:  SuiObjectId;
  from_branch:  string;
  into_branch:  string;
  resolver_id:  SuiObjectId;
  ttl_ms:       number;
  proposer:     SuiAddress;
  ts_ms:        number;
  tx_digest:    string;
}

export interface AttestationSubmittedEvent {
  tree_id:     SuiObjectId;
  proposal_id: SuiObjectId;
  signer:      SuiAddress;
  kind:        number;   // 0x01=JURY_VOTE 0x02=EVALUATOR 0x03=ORACLE 0x04=LLM_RESOLVE
  ts_ms:       number;
  tx_digest:   string;
}

export interface MergeFinalizedEvent {
  tree_id:     SuiObjectId;
  proposal_id: SuiObjectId;
  commit_id:   SuiObjectId;
  verdict:     string;   // "APPROVE" | "REJECT"
  ts_ms:       number;
  tx_digest:   string;
}

export interface MergeAbortedEvent {
  tree_id:     SuiObjectId;
  proposal_id: SuiObjectId;
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

// ─── App-level domain models ─────────────────────────────────────────────────

export interface MemoryCommit {
  id:               SuiObjectId;
  tree_id:          SuiObjectId;
  branch:           string;
  parents:          SuiObjectId[];
  memwal_namespace: string;
  memwal_blob_id:   BlobId;
  author:           SuiAddress;
  is_merge:         boolean;
  ts_ms:            number;
  tx_digest:        string;
  /** Short 7-char prefix of the object ID, for display. */
  short_id:         string;
  /** Human-readable auto-message, fetched lazily from MemWal. */
  message:          string | null;
}

export interface MemoryBranch {
  name:             string;
  from_branch:      string;
  memwal_namespace: string;
  /** Object ID of the head commit on this branch. Computed from commits list. */
  head_commit_id:   SuiObjectId | null;
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
  id:           SuiObjectId;
  tree_id:      SuiObjectId;
  from_branch:  string;
  into_branch:  string;
  resolver_id:  SuiObjectId;
  proposer:     SuiAddress;
  status:       ProposalStatus;
  attestations: AttestationRecord[];
  /** Present once finalized. */
  merge_commit_id: SuiObjectId | null;
  ts_ms:        number;
  tx_digest:    string;
}

// ─── Attestation kind labels ──────────────────────────────────────────────────

export const ATTEST_KIND: Record<number, string> = {
  0x01: "JURY_VOTE",
  0x02: "EVALUATOR",
  0x03: "ORACLE",
  0x04: "LLM_RESOLVE",
};
