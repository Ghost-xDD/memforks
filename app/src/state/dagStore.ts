/**
 * Global DAG state — all MemoryCommits, MemoryBranches, and MergeProposals
 * derived from on-chain events.
 */

import { create } from "zustand";
import type {
  MemoryCommit,
  MemoryBranch,
  MergeProposal,
  AttestationRecord,
  CommitCreatedEvent,
  BranchCreatedEvent,
  MergeProposedEvent,
  AttestationSubmittedEvent,
  MergeFinalizedEvent,
  MergeAbortedEvent,
} from "../sui/types.js";

function shortId(id: string): string {
  // Strip 0x prefix, take first 7 hex chars.
  return id.replace(/^0x/, "").slice(0, 7);
}

interface DagState {
  commits:   Map<string, MemoryCommit>;
  branches:  Map<string, MemoryBranch>;
  proposals: Map<string, MergeProposal>;

  // Derived: ordered array of all commits by ts_ms (for layout).
  orderedCommits: MemoryCommit[];

  isLive:    boolean;
  lastEvent: number; // ts_ms of most recent event — triggers animation

  // Active tree (set after runtime config loads).
  treeId: string | null;
  setTreeId: (id: string) => void;

  // IDs of commits that just arrived live — cleared after 2 s for pop-in CSS.
  newCommitIds:   Set<string>;
  clearNewCommit: (id: string) => void;

  // Mutations called by the Sui event handlers.
  applyCommit:      (e: CommitCreatedEvent)        => void;
  applyBranch:      (e: BranchCreatedEvent)        => void;
  applyProposal:    (e: MergeProposedEvent)        => void;
  applyAttestation: (e: AttestationSubmittedEvent) => void;
  applyFinalized:   (e: MergeFinalizedEvent)       => void;
  applyAborted:     (e: MergeAbortedEvent)         => void;
  setLive:          (v: boolean)                   => void;
  reset:            ()                             => void;
}

function sortedCommits(commits: Map<string, MemoryCommit>): MemoryCommit[] {
  return Array.from(commits.values()).sort((a, b) => a.ts_ms - b.ts_ms);
}

export const useDagStore = create<DagState>((set, get) => ({
  commits:        new Map(),
  branches:       new Map(),
  proposals:      new Map(),
  orderedCommits: [],
  isLive:         false,
  lastEvent:      0,
  treeId:         null,
  newCommitIds:   new Set(),

  setTreeId(id) { set({ treeId: id }); },

  clearNewCommit(id) {
    set((s) => {
      const next = new Set(s.newCommitIds);
      next.delete(id);
      return { newCommitIds: next };
    });
  },

  applyCommit(e) {
    const commits = new Map(get().commits);
    const commit: MemoryCommit = {
      id:               e.commit_id,
      tree_id:          e.tree_id,
      branch:           e.branch,
      parents:          e.parents,
      memwal_namespace: e.memwal_namespace,
      memwal_blob_id:   e.memwal_blob_id,
      author:           e.author,
      is_merge:         e.is_merge,
      ts_ms:            e.ts_ms,
      tx_digest:        e.tx_digest,
      short_id:         shortId(e.commit_id),
      message:          null,
    };
    commits.set(e.commit_id, commit);

    // Advance the branch head.
    const branches = new Map(get().branches);
    const branch = branches.get(e.branch);
    if (branch) {
      branches.set(e.branch, { ...branch, head_commit_id: e.commit_id });
    } else {
      // Commit arrived before a BranchCreated event (e.g. genesis on main).
      branches.set(e.branch, {
        name:             e.branch,
        from_branch:      "",
        memwal_namespace: e.memwal_namespace,
        head_commit_id:   e.commit_id,
        ts_ms:            e.ts_ms,
      });
    }

    const newIds = new Set(get().newCommitIds);
    newIds.add(e.commit_id);

    set({
      commits,
      branches,
      orderedCommits: sortedCommits(commits),
      lastEvent:      e.ts_ms,
      newCommitIds:   newIds,
    });

    // Clear the "new" marker after the pop-in animation completes.
    setTimeout(() => {
      get().clearNewCommit(e.commit_id);
    }, 2_000);
  },

  applyBranch(e) {
    const branches = new Map(get().branches);
    const existing = branches.get(e.branch);
    branches.set(e.branch, {
      name:             e.branch,
      from_branch:      e.from_branch,
      memwal_namespace: e.memwal_namespace,
      head_commit_id:   existing?.head_commit_id ?? null,
      ts_ms:            e.ts_ms,
    });
    set({ branches, lastEvent: e.ts_ms });
  },

  applyProposal(e) {
    const proposals = new Map(get().proposals);
    proposals.set(e.proposal_id, {
      id:              e.proposal_id,
      tree_id:         e.tree_id,
      from_branch:     e.from_branch,
      into_branch:     e.into_branch,
      resolver_id:     e.resolver_id,
      proposer:        e.proposer,
      status:          "pending",
      attestations:    [],
      merge_commit_id: null,
      ts_ms:           e.ts_ms,
      tx_digest:       e.tx_digest,
    });
    set({ proposals, lastEvent: e.ts_ms });
  },

  applyAttestation(e) {
    const proposals = new Map(get().proposals);
    const proposal = proposals.get(e.proposal_id);
    if (!proposal) return;
    const attestation: AttestationRecord = {
      signer:    e.signer,
      kind:      e.kind,
      tx_digest: e.tx_digest,
      ts_ms:     e.ts_ms,
    };
    proposals.set(e.proposal_id, {
      ...proposal,
      attestations: [...proposal.attestations, attestation],
    });
    set({ proposals, lastEvent: e.ts_ms });
  },

  applyFinalized(e) {
    const proposals = new Map(get().proposals);
    const proposal = proposals.get(e.proposal_id);
    if (!proposal) return;
    proposals.set(e.proposal_id, {
      ...proposal,
      status:          "finalized",
      merge_commit_id: e.commit_id,
    });
    set({ proposals, lastEvent: e.ts_ms });
  },

  applyAborted(e) {
    const proposals = new Map(get().proposals);
    const proposal = proposals.get(e.proposal_id);
    if (!proposal) return;
    proposals.set(e.proposal_id, { ...proposal, status: "aborted" });
    set({ proposals, lastEvent: e.ts_ms });
  },

  setLive(v) { set({ isLive: v }); },

  reset() {
    set({
      commits:        new Map(),
      branches:       new Map(),
      proposals:      new Map(),
      orderedCommits: [],
      isLive:         false,
      lastEvent:      0,
      newCommitIds:   new Set(),
    });
  },
}));
