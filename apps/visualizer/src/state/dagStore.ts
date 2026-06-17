/**
 * Global DAG state — MemoryBranches and MergeProposals derived from on-chain events.
 *
 * Model A: commits are off-chain Walrus blobs; no CommitCreated events are emitted.
 * The DAG is reconstructed via BranchCreated and MergeFinalized events.
 * Branch heads are Walrus blob IDs (empty = at genesis).
 */

import { create } from "zustand";
import type {
  MergeAnchor,
  MemoryBranch,
  MergeProposal,
  AttestationRecord,
  OffChainCommit,
  BranchCreatedEvent,
  MergeProposedEvent,
  AttestationSubmittedEvent,
  MergeFinalizedEvent,
  MergeAbortedEvent,
} from "../sui/types.js";

function shortId(id: string): string {
  return id.replace(/^0x/, "").slice(0, 7);
}

interface DagState {
  mergeAnchors: Map<string, MergeAnchor>;
  branches:     Map<string, MemoryBranch>;
  proposals:    Map<string, MergeProposal>;

  /** Off-chain commits fetched from /api/history, keyed by blob_id. */
  offChainCommits: Map<string, OffChainCommit>;

  /** Ordered merge anchors by ts_ms for timeline display. */
  orderedAnchors: MergeAnchor[];
  /** All off-chain commits, sorted oldest-first. */
  orderedCommits: OffChainCommit[];
  /** All branches, sorted oldest-first — for fork rows in the timeline. */
  orderedBranches: MemoryBranch[];

  isLive:    boolean;
  lastEvent: number;

  treeId: string | null;
  setTreeId: (id: string) => void;

  /** Anchor IDs that just arrived live — cleared after 2 s for pop-in CSS. */
  newAnchorIds:   Set<string>;
  clearNewAnchor: (id: string) => void;

  /** Branch names that just arrived live — cleared after 2 s for pop-in CSS. */
  newBranchIds:   Set<string>;
  clearNewBranch: (name: string) => void;

  applyBranch:         (e: BranchCreatedEvent)        => void;
  applyProposal:       (e: MergeProposedEvent)        => void;
  applyAttestation:    (e: AttestationSubmittedEvent) => void;
  applyFinalized:      (e: MergeFinalizedEvent)       => void;
  applyAborted:        (e: MergeAbortedEvent)         => void;
  /** Load off-chain commit history from /api/history for a branch. Merges by blob_id. */
  applyOffChainCommits: (commits: OffChainCommit[]) => void;
  /** Patch display-only fields onto a proposal (resolver_label, jury config). */
  enrichProposal:      (id: string, patch: Partial<Pick<MergeProposal, "resolver_label" | "jury_threshold" | "jury_judges">>) => void;
  /** Mark a branch as rejected/graveyard with an optional rationale. */
  markGraveyard:       (name: string, rationale?: string) => void;
  setLive:             (v: boolean)                   => void;
  reset:               ()                             => void;
}

function sortedAnchors(anchors: Map<string, MergeAnchor>): MergeAnchor[] {
  return Array.from(anchors.values()).sort((a, b) => a.ts_ms - b.ts_ms);
}

function sortedCommits(commits: Map<string, OffChainCommit>): OffChainCommit[] {
  return Array.from(commits.values()).sort((a, b) => a.ts_ms - b.ts_ms);
}

function sortedBranches(branches: Map<string, MemoryBranch>): MemoryBranch[] {
  return Array.from(branches.values()).sort((a, b) => a.ts_ms - b.ts_ms);
}

export const useDagStore = create<DagState>((set, get) => ({
  mergeAnchors:    new Map(),
  branches:        new Map(),
  proposals:       new Map(),
  offChainCommits: new Map(),
  orderedAnchors:  [],
  orderedCommits:  [],
  orderedBranches: [],
  isLive:          false,
  lastEvent:       0,
  treeId:          null,
  newAnchorIds:    new Set(),
  newBranchIds:    new Set(),

  setTreeId(id) { set({ treeId: id }); },

  clearNewAnchor(id) {
    set((s) => {
      const next = new Set(s.newAnchorIds);
      next.delete(id);
      return { newAnchorIds: next };
    });
  },

  clearNewBranch(name) {
    set((s) => {
      const next = new Set(s.newBranchIds);
      next.delete(name);
      return { newBranchIds: next };
    });
  },

  applyBranch(e) {
    const branches  = new Map(get().branches);
    const existing  = branches.get(e.branch);
    branches.set(e.branch, {
      name:             e.branch,
      from_branch:      e.from_branch,
      memwal_namespace: e.memwal_namespace,
      // Preserve existing head if BranchCreated arrives out-of-order after a merge.
      head_blob_id:     existing?.head_blob_id ?? "",
      ts_ms:            e.ts_ms,
      tx_digest:        e.tx_digest,
    });

    const newIds = new Set(get().newBranchIds);
    newIds.add(e.branch);

    set({ branches, orderedBranches: sortedBranches(branches), lastEvent: e.ts_ms, newBranchIds: newIds });
    setTimeout(() => get().clearNewBranch(e.branch), 2_000);
  },

  applyProposal(e) {
    const proposals = new Map(get().proposals);
    proposals.set(e.proposal_id, {
      id:                e.proposal_id,
      tree_id:           e.tree_id,
      from_branch:       e.from_branch,
      into_branch:       e.into_branch,
      from_head_blob_id: e.from_head_blob_id,
      into_head_blob_id: e.into_head_blob_id,
      resolver_id:       e.resolver_id,
      proposer:          "",
      status:            "pending",
      attestations:      [],
      merge_commit_id:   null,
      resolved_blob_id:  null,
      expires_at_ms:     e.expires_at_ms,
      ts_ms:             e.ts_ms,
      tx_digest:         e.tx_digest,
    });
    set({ proposals, lastEvent: e.ts_ms });
  },

  applyAttestation(e) {
    const proposals = new Map(get().proposals);
    const proposal  = proposals.get(e.proposal_id);
    if (!proposal) return;

    // GAP-4: auto-generate sequential judge labels if not provided by the
    // event or prior enrichment.  Labels are positional within this proposal.
    const existingSigners = proposal.attestations.map((a) => a.signer);
    const judgeIndex = existingSigners.indexOf(e.signer) >= 0
      ? existingSigners.indexOf(e.signer)
      : existingSigners.length;
    const autoLabel = e.label ?? `judge-${judgeIndex + 1}`;

    const attestation: AttestationRecord = {
      signer:        e.signer,
      kind:          e.kind,
      tx_digest:     e.tx_digest,
      ts_ms:         e.ts_ms,
      label:         autoLabel,
      model:         e.model,
      vote:          e.vote,
      sig_verified:  e.sig_verified,
    };

    // If this signer already has an attestation on this proposal (duplicate
    // submission guard), skip.
    if (existingSigners.includes(e.signer)) {
      proposals.set(e.proposal_id, {
        ...proposal,
        attestations: proposal.attestations.map((a) =>
          a.signer === e.signer ? { ...a, ...attestation } : a,
        ),
      });
    } else {
      proposals.set(e.proposal_id, {
        ...proposal,
        attestations: [...proposal.attestations, attestation],
      });
    }
    set({ proposals, lastEvent: e.ts_ms });
  },

  applyFinalized(e) {
    // Update proposal status.
    const proposals = new Map(get().proposals);
    const proposal  = proposals.get(e.proposal_id);
    if (proposal) {
      proposals.set(e.proposal_id, {
        ...proposal,
        status:          "finalized",
        merge_commit_id: e.merge_commit_id,
        resolved_blob_id: e.resolved_blob_id,
      });
    }

    // Advance the into_branch head.
    const branches  = new Map(get().branches);
    if (proposal?.into_branch) {
      const branch = branches.get(proposal.into_branch);
      if (branch) {
        branches.set(proposal.into_branch, {
          ...branch,
          head_blob_id: e.resolved_blob_id,
        });
      }
    }

    // Record a merge anchor for timeline / DAG display.
    const anchors  = new Map(get().mergeAnchors);
    const anchor: MergeAnchor = {
      id:               e.merge_commit_id,
      tree_id:          e.tree_id,
      branch:           proposal?.into_branch ?? "",
      parents:          [proposal?.from_head_blob_id ?? "", proposal?.into_head_blob_id ?? ""],
      memwal_namespace: "",
      resolved_blob_id: e.resolved_blob_id,
      author:           "",
      proposal_id:      e.proposal_id,
      ts_ms:            e.ts_ms,
      tx_digest:        e.tx_digest,
    };
    anchors.set(e.merge_commit_id, anchor);

    const newIds = new Set(get().newAnchorIds);
    newIds.add(e.merge_commit_id);

    set({
      proposals,
      branches,
      mergeAnchors:   anchors,
      orderedAnchors: sortedAnchors(anchors),
      lastEvent:      e.ts_ms,
      newAnchorIds:   newIds,
    });

    setTimeout(() => get().clearNewAnchor(e.merge_commit_id), 2_000);
  },

  applyAborted(e) {
    const proposals = new Map(get().proposals);
    const proposal  = proposals.get(e.proposal_id);
    if (!proposal) return;
    proposals.set(e.proposal_id, { ...proposal, status: "aborted" });
    set({ proposals, lastEvent: e.ts_ms });
  },

  applyOffChainCommits(commits) {
    const map = new Map(get().offChainCommits);
    for (const c of commits) map.set(c.blob_id, c);
    set({ offChainCommits: map, orderedCommits: sortedCommits(map) });
  },

  enrichProposal(id, patch) {
    const proposals = new Map(get().proposals);
    const existing  = proposals.get(id);
    if (!existing) return;
    proposals.set(id, { ...existing, ...patch });
    set({ proposals });
  },

  markGraveyard(name, rationale) {
    const branches = new Map(get().branches);
    const branch   = branches.get(name);
    if (!branch) return;
    branches.set(name, { ...branch, is_graveyard: true, rejection_rationale: rationale });
    set({ branches, orderedBranches: sortedBranches(branches) });
  },

  setLive(v) { set({ isLive: v }); },

  reset() {
    set({
      mergeAnchors:    new Map(),
      branches:        new Map(),
      proposals:       new Map(),
      offChainCommits: new Map(),
      orderedAnchors:  [],
      orderedCommits:  [],
      orderedBranches: [],
      isLive:          false,
      lastEvent:       0,
      newAnchorIds:    new Set(),
      newBranchIds:    new Set(),
    });
  },
}));

// ─── Re-export shortId for use in views ──────────────────────────────────────
export { shortId };
