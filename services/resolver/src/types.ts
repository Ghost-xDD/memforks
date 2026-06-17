/**
 * Shared types for the off-chain resolver runtime.
 */

// ─── Config ──────────────────────────────────────────────────────────────────

export interface LlmProviderConfig {
  provider: "openai" | "anthropic";
  model: string;
  apiKey: string;
}

export interface JudgeConfig {
  /** suiprivkey1... bech32 — the judge's Sui keypair. */
  privateKey: string;
  /** Optional LLM the judge uses to evaluate the merge proposal. */
  llm?: LlmProviderConfig;
}

export interface RuntimeConfig {
  /** Sui RPC endpoint. */
  rpcUrl: string;
  /** Deployed MemForks Move package ID. */
  packageId: string;
  /** The MemoryTree to watch. */
  treeId: string;
  /**
   * Keypair with MERGE permission on all managed branches.
   * Called finalize_merge once the resolver approves.
   */
  finalizerKey: string;
  /** Jury member workers (each has their own Sui keypair). */
  judges: JudgeConfig[];
  /** The single LLM runner that produces reconciled payloads. */
  llmRunner?: {
    privateKey: string;
    llm: LlmProviderConfig;
  };
  /** MemWal credentials for reading/writing branch content. */
  memwal?: {
    delegateKey: string;
    accountId: string;
    serverUrl?: string;
  };
  /** How often to poll for new MergeProposed events (ms). Default 5 000. */
  pollIntervalMs?: number;
}

// ─── Runtime state ───────────────────────────────────────────────────────────

export type ProposalPhase =
  | "jury"        // waiting for k jury votes
  | "llm"         // jury approved; LLM runner producing resolution
  | "finalizing"  // submitting finalize_merge tx
  | "done"        // terminal state
  | "aborted";

export interface VoteRecord {
  judge: string;
  verdict: "approve" | "reject";
  reasoning: string;
  txDigest: string;
}

export interface ProposalState {
  proposalId: string;
  treeId: string;
  fromBranch: string;
  intoBranch: string;
  resolverKind: number;
  /** Raw BCS config of the top-level resolver. */
  resolverConfig: Uint8Array;
  phase: ProposalPhase;
  /** Track which judges already voted (prevents duplicate submission). */
  judgesVoted: Set<string>;
  /** Full vote records — used for rejection rationale writeback. */
  voteLog: VoteRecord[];
  /** Resolved namespace/blobId once the LLM runner finishes. */
  resolvedNamespace?: string;
  resolvedBlobId?: string;
}
