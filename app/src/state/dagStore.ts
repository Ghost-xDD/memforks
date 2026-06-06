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

  /** Ordered merge anchors by ts_ms for timeline display. */
  orderedAnchors: MergeAnchor[];

  isLive:    boolean;
  lastEvent: number;

  treeId: string | null;
  setTreeId: (id: string) => void;

  /** Anchor IDs that just arrived live — cleared after 2 s for pop-in CSS. */
  newAnchorIds:   Set<string>;
  clearNewAnchor: (id: string) => void;

  applyBranch:      (e: BranchCreatedEvent)        => void;
  applyProposal:    (e: MergeProposedEvent)        => void;
  applyAttestation: (e: AttestationSubmittedEvent) => void;
  applyFinalized:   (e: MergeFinalizedEvent)       => void;
  applyAborted:     (e: MergeAbortedEvent)         => void;
  setLive:          (v: boolean)                   => void;
  reset:            ()                             => void;
}

function sortedAnchors(anchors: Map<string, MergeAnchor>): MergeAnchor[] {
  return Array.from(anchors.values()).sort((a, b) => a.ts_ms - b.ts_ms);
}

export const useDagStore = create<DagState>((set, get) => ({
  mergeAnchors:   new Map(),
  branches:       new Map(),
  proposals:      new Map(),
  orderedAnchors: [],
  isLive:         false,
  lastEvent:      0,
  treeId:         null,
  newAnchorIds:   new Set(),

  setTreeId(id) { set({ treeId: id }); },

  clearNewAnchor(id) {
    set((s) => {
      const next = new Set(s.newAnchorIds);
      next.delete(id);
      return { newAnchorIds: next };
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
    });
    set({ branches, lastEvent: e.ts_ms });
  },

  applyProposal(e) {
    const proposals = new Map(get().proposals);
    proposals.set(e.proposal_id, {
      id:               e.proposal_id,
      tree_id:          e.tree_id,
      from_branch:      e.from_branch,
      into_branch:      e.into_branch,
      from_head_blob_id: e.from_head_blob_id,
      into_head_blob_id: e.into_head_blob_id,
      resolver_id:      e.resolver_id,
      proposer:         "",
      status:           "pending",
      attestations:     [],
      merge_commit_id:  null,
      resolved_blob_id: null,
      ts_ms:            e.ts_ms,
      tx_digest:        e.tx_digest,
    });
    set({ proposals, lastEvent: e.ts_ms });
  },

  applyAttestation(e) {
    const proposals = new Map(get().proposals);
    const proposal  = proposals.get(e.proposal_id);
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

  setLive(v) { set({ isLive: v }); },

  reset() {
    set({
      mergeAnchors:   new Map(),
      branches:       new Map(),
      proposals:      new Map(),
      orderedAnchors: [],
      isLive:         false,
      lastEvent:      0,
      newAnchorIds:   new Set(),
    });
  },
}));

// ─── Re-export shortId for use in views ──────────────────────────────────────
export { shortId };
