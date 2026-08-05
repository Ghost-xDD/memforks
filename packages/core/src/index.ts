/**
 * @memfork/core — public API
 *
 * Primary entry: MemForksClient (branch / commit / recall / grant / revoke / merge)
 * Indexer:       MemForksIndexer (event-driven branch + merge state)
 * Types:         all SPEC §3–10 types and constants
 */

export { MemForksClient } from "./client.js";
export type { MemForksClientConfig, MemWalConfig } from "./client.js";

export {
  LocalMemoryProvider,
} from "./memory-provider.js";
export type {
  MemoryProvider,
  MemoryRecallHit,
  MemoryBackendConfig,
  MemWalBackendConfig,
  LocalBackendConfig,
} from "./memory-provider.js";

// Convenience alias matching the DX.md API surface.
// `import { MemoryClient } from '@memfork/core'` works alongside MemForksClient.
export { MemForksClient as MemoryClient } from "./client.js";

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
export { emitTelemetry } from "./telemetry.js";
export type { TelemetryEvent } from "./telemetry.js";
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

// `perms` alias for PERM — matches the DX.md import surface:
// `import { resolvers, perms } from '@memfork/core'`
export { PERM as perms } from "./types.js";

export type {
  PermFlags,
  ResolverKind,
  AttestKind,
  ProposalStatus,
  ArtifactRef,
  CommitDelta,
  CommitPayload,
  CommitEntry,
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

// Artifact storage helpers (opt-in, requires WAL-funded keypair).
export { putArtifact, getArtifact, sha256Hex as artifactSha256, ArtifactStorageError, DEFAULT_ARTIFACT_CONFIG } from "./artifacts.js";
export type { ArtifactConfig } from "./artifacts.js";

// Sui gRPC helpers (JSON-RPC is deprecated on Foundation fullnodes).
export {
  createSuiClient,
  grpcUrlForNetwork,
  SuiGrpcClient,
  tableIdFromField,
  stringFieldName,
  addressFieldName,
  addressFromBcs,
  utf8FromVectorU8,
} from "./sui.js";
export type { CreatedObjectChange, ExecutedTx, SuiNetwork } from "./sui.js";
