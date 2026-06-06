/**
 * @memfork/core — public API
 *
 * Primary entry: MemForksClient (branch / commit / recall / grant / revoke / merge)
 * Indexer:       MemForksIndexer (event-driven branch + merge state)
 * Types:         all SPEC §3–10 types and constants
 */

export { MemForksClient } from "./client.js";
export type { MemForksClientConfig, MemWalConfig } from "./client.js";

export { resolvers } from "./resolvers.js";
export {
  decodeJuryConfig,
  decodeLlmConfig,
  decodeChildren,
  onChainBytesToUint8Array,
  addrToBytes,
  bytesToAddr,
} from "./resolvers.js";
export type {
  ResolverDef,
  DecodedJuryConfig,
  DecodedLlmConfig,
  DecodedChildConfig,
} from "./resolvers.js";

export { MemForksIndexer } from "./indexer.js";
export type { MemForksIndexerConfig, BranchState, MergeAnchor } from "./indexer.js";

export {
  PERM,
  PERM_ALL,
  RESOLVER_KIND,
  ATTEST_KIND,
  PROPOSAL_STATUS,
  ERROR_CODE,
  PAYLOAD_VERSION,
  branchNamespace,
} from "./types.js";

export type {
  PermFlags,
  ResolverKind,
  AttestKind,
  ProposalStatus,
  CommitDelta,
  CommitPayload,
  OnChainTree,
  OnChainCommit,
  OnChainAttestation,
  OnChainDelegateCap,
  OnChainBranchACL,
  OnChainResolverRef,
  OnChainMergeProposal,
  TreeCreatedEvent,
  DelegateGrantedEvent,
  DelegateRevokedEvent,
  BranchCreatedEvent,
  MergeProposedEvent,
  AttestationSubmittedEvent,
  MergeFinalizedEvent,
  MergeAbortedEvent,
  MergeExpiredEvent,
  MemForksConfig,
  ResolverConfig,
} from "./types.js";
