/**
 * HistoryView — unified timeline of off-chain commits, on-chain fork events,
 * and on-chain merge anchors.
 *
 * Three row types:
 *   commit  — off-chain Walrus blob (author, tool badge, branch pill)
 *   fork    — on-chain BranchCreated event (⑂ glyph, source branch)
 *   anchor  — on-chain MergeFinalized (◈ diamond node, jury/resolver summary)
 *
 * The visual rhythm between light commit rows and heavier on-chain rows teaches
 * the Model A architecture — cheap fast memories, anchored settlements — without
 * any voiceover.
 */

import { useMemo } from "react";
import { useDagStore } from "../../state/dagStore.js";
import { useUiStore } from "../../state/uiStore.js";
import { branchTone } from "../../ui/branch.js";
import type { OffChainCommit, MergeAnchor, MemoryBranch } from "../../sui/types.js";
import "./HistoryView.css";


// ─── Types ────────────────────────────────────────────────────────────────────

type TimelineEntry =
  | { kind: "commit"; item: OffChainCommit }
  | { kind: "fork";   item: MemoryBranch   }
  | { kind: "anchor"; item: MergeAnchor    };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1_000);
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30)  return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

function absTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

const TOOL_LABEL: Record<string, string> = {
  codex:  "Codex",
  cursor: "Cursor",
  sdk:    "SDK",
};

// ─── Gutter ───────────────────────────────────────────────────────────────────

interface GutterProps {
  nodeClass: string;
  hideTop:   boolean;
  hideBot:   boolean;
}

function Gutter({ nodeClass, hideTop, hideBot }: GutterProps) {
  return (
    <div className="history-gutter" aria-hidden>
      <span className="history-line history-line-top"
        style={{ visibility: hideTop ? "hidden" : "visible" }} />
      <span className={`history-node ${nodeClass}`} />
      <span className="history-line history-line-bottom"
        style={{ visibility: hideBot ? "hidden" : "visible" }} />
    </div>
  );
}

// ─── Row components ───────────────────────────────────────────────────────────

function CommitRow({ commit, isFirst, isLast, showBranch, onOpen, isSelected }: {
  commit:     OffChainCommit;
  isFirst:    boolean;
  isLast:     boolean;
  showBranch: boolean;
  onOpen:     () => void;
  isSelected: boolean;
}) {
  const tool    = commit.tool ? TOOL_LABEL[commit.tool] : null;
  const tooltip = [
    absTime(commit.ts_ms),
    `blob ${commit.blob_id.slice(0, 12)}…`,
    tool && `via ${tool}`,
  ].filter(Boolean).join("\n");

  return (
    <li
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      className={`history-row history-row--commit${isSelected ? " selected" : ""}`}
      title={tooltip}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}
    >
      <Gutter
        nodeClass={`branch-${branchTone(commit.branch)}`}
        hideTop={isFirst}
        hideBot={isLast}
      />
      <div className="history-content">
        <div className="history-top-row">
          <span className="history-message">{commit.message}</span>
        </div>
        <div className="history-meta-row">
          {commit.author && (
            <>
              <span className="history-author">{commit.author}</span>
              <span className="history-sep" aria-hidden>·</span>
            </>
          )}
          {showBranch && (
            <>
              <span className={`chip ${branchTone(commit.branch)}`}>{commit.branch}</span>
              <span className="history-sep" aria-hidden>·</span>
            </>
          )}
          <span className="history-time">{relTime(commit.ts_ms)}</span>
        </div>
      </div>
    </li>
  );
}

function ForkRow({ branch, isFirst, isLast, isNew }: {
  branch:  MemoryBranch;
  isFirst: boolean;
  isLast:  boolean;
  isNew:   boolean;
}) {
  const tooltip = [
    absTime(branch.ts_ms),
    branch.tx_digest && `tx ${branch.tx_digest.slice(0, 16)}…`,
  ].filter(Boolean).join("\n");

  return (
    <li
      className={`history-row history-row--fork${isNew ? " is-new" : ""}`}
      title={tooltip}
    >
      <Gutter
        nodeClass={`history-node--fork branch-${branchTone(branch.name)}`}
        hideTop={isFirst}
        hideBot={isLast}
      />
      <div className="history-content">
        <div className="history-top-row history-fork-top">
          <span className="history-fork-glyph" aria-hidden>⑂</span>
          <span className="history-fork-label">
            <strong>{branch.name}</strong> forked from <strong>{branch.from_branch}</strong>
          </span>
          <span className="history-flex-spacer" />
          {branch.tx_digest && <span className="history-onchain-glyph" title="on-chain">◈</span>}
          <span className="history-time">{relTime(branch.ts_ms)}</span>
        </div>
      </div>
    </li>
  );
}

function AnchorRow({ anchor, proposal, isFirst, isLast, isSelected, isNew, onOpen }: {
  anchor:     MergeAnchor;
  proposal:   ReturnType<typeof import("../../state/dagStore.js").useDagStore.getState>["proposals"]["get"] extends (k: string) => infer R ? R : never;
  isFirst:    boolean;
  isLast:     boolean;
  isSelected: boolean;
  isNew:      boolean;
  onOpen:     () => void;
}) {
  const intoBranch    = anchor.branch;
  const attestCount   = proposal?.attestations.length ?? 0;
  const resolverLabel = proposal?.resolver_label ?? null;

  return (
    <li
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      className={`history-row history-row--anchor${isSelected ? " selected" : ""}${isNew ? " is-new" : ""}`}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}
      title={`${absTime(anchor.ts_ms)}\nanchor ${anchor.id.slice(0, 16)}…`}
    >
      <Gutter
        nodeClass="history-node--anchor merge"
        hideTop={isFirst}
        hideBot={isLast}
      />
      <div className="history-content">
        <div className="history-top-row">
          <span className="history-onchain-glyph history-onchain-glyph--anchor" aria-hidden>◈</span>
          <span className="history-message">
            merged{" "}
            {proposal
              ? <>
                  <strong>{proposal.from_branch}</strong> → <strong>{intoBranch}</strong>
                </>
              : <strong>{intoBranch}</strong>}
          </span>
        </div>
        <div className="history-meta-row">
          {resolverLabel && (
            <>
              <span className="history-resolver-label">{resolverLabel}</span>
              <span className="history-sep" aria-hidden>·</span>
            </>
          )}
          {attestCount > 0 && (
            <>
              <span className="history-parents-hint">{attestCount} attest.</span>
              <span className="history-sep" aria-hidden>·</span>
            </>
          )}
          <span className="history-time">{relTime(anchor.ts_ms)}</span>
        </div>
      </div>
    </li>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function HistoryView() {
  const orderedCommits  = useDagStore((s) => s.orderedCommits);
  const orderedAnchors  = useDagStore((s) => s.orderedAnchors);
  const orderedBranches = useDagStore((s) => s.orderedBranches);
  const proposals       = useDagStore((s) => s.proposals);
  const newAnchorIds    = useDagStore((s) => s.newAnchorIds);
  const newBranchIds    = useDagStore((s) => s.newBranchIds);

  const activeBranch = useUiStore((s) => s.activeBranch);
  const panel        = useUiStore((s) => s.panel);
  const openAnchor   = useUiStore((s) => s.openAnchor);
  const openCommit   = useUiStore((s) => s.openCommit);
  const replayActive = useUiStore((s) => s.replayActive);
  const replayIndex  = useUiStore((s) => s.replayIndex);

  const selectedAnchorId = panel?.kind === "anchor" ? panel.anchor.id : null;
  const selectedBlobId   = panel?.kind === "commit"  ? panel.commit.blob_id : null;

  const timeline = useMemo((): TimelineEntry[] => {
    // Off-chain commits — filter by active branch
    const commits: TimelineEntry[] = orderedCommits
      .filter((c) => !activeBranch || c.branch === activeBranch)
      .map((c) => ({ kind: "commit", item: c }));

    // Fork events — skip genesis (from_branch === ""); show creation of active branch
    const forks: TimelineEntry[] = orderedBranches
      .filter((b) => b.from_branch !== "")
      .filter((b) => !activeBranch || b.name === activeBranch)
      .map((b) => ({ kind: "fork", item: b }));

    // On-chain merge anchors
    const anchors: TimelineEntry[] = orderedAnchors
      .filter((a) => !activeBranch || a.branch === activeBranch)
      .map((a) => ({ kind: "anchor", item: a }));

    const merged = [...commits, ...forks, ...anchors]
      .sort((a, b) => a.item.ts_ms - b.item.ts_ms);

    const sliced = replayActive ? merged.slice(0, replayIndex) : merged;
    return [...sliced].reverse();
  }, [
    orderedCommits,
    orderedBranches,
    orderedAnchors,
    activeBranch,
    replayActive,
    replayIndex,
  ]);

  if (timeline.length === 0) {
    return (
      <div className="history-empty">
        <p>No history{activeBranch ? ` on ${activeBranch}` : ""}.</p>
        <p className="history-empty-sub">
          Commits appear when loaded via <code>memfork ui</code>.
          Branch forks and merge settlements appear live from on-chain events.
        </p>
      </div>
    );
  }

  const commitCount = timeline.filter((e) => e.kind === "commit").length;
  const forkCount   = timeline.filter((e) => e.kind === "fork").length;
  const anchorCount = timeline.filter((e) => e.kind === "anchor").length;

  const summaryParts: string[] = [];
  if (commitCount) summaryParts.push(`${commitCount} commit${commitCount !== 1 ? "s" : ""}`);
  if (forkCount)   summaryParts.push(`${forkCount} fork${forkCount !== 1 ? "s" : ""}`);
  if (anchorCount) summaryParts.push(`${anchorCount} merge${anchorCount !== 1 ? "s" : ""}`);

  return (
    <div className="history-view">
      <div className="history-header">
        <span className="history-header-count">{summaryParts.join(" · ")}</span>
        {activeBranch && (
          <span className={`chip ${branchTone(activeBranch)}`}>
            {activeBranch}
          </span>
        )}
      </div>

      <ul className="history-list" role="list" aria-label="Branch history">
        {timeline.map((entry, i) => {
          const isFirst = i === 0;
          const isLast  = i === timeline.length - 1;

          if (entry.kind === "commit") {
            return (
              <CommitRow
                key={entry.item.blob_id}
                commit={entry.item}
                isFirst={isFirst}
                isLast={isLast}
                showBranch={!activeBranch}
                isSelected={entry.item.blob_id === selectedBlobId}
                onOpen={() => openCommit(entry.item)}
              />
            );
          }

          if (entry.kind === "fork") {
            return (
              <ForkRow
                key={`fork-${entry.item.name}`}
                branch={entry.item}
                isFirst={isFirst}
                isLast={isLast}
                isNew={newBranchIds.has(entry.item.name)}
              />
            );
          }

          // anchor
          const a = entry.item;
          return (
            <AnchorRow
              key={a.id}
              anchor={a}
              proposal={proposals.get(a.proposal_id)}
              isFirst={isFirst}
              isLast={isLast}
              isSelected={a.id === selectedAnchorId}
              isNew={newAnchorIds.has(a.id)}
              onOpen={() => openAnchor(a)}
            />
          );
        })}
      </ul>
    </div>
  );
}
