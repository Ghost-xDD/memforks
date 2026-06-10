/**
 * HistoryView — unified timeline of off-chain commits and on-chain merge anchors.
 *
 * Off-chain commits arrive from /api/history (MemWal, server-proxied).
 * Merge anchors arrive from on-chain MergeFinalized events.
 * Both are merged into one list, sorted newest-first.
 */

import { useMemo } from "react";
import { useDagStore } from "../../state/dagStore.js";
import { useUiStore } from "../../state/uiStore.js";
import type { OffChainCommit, MergeAnchor } from "../../sui/types.js";
import "./HistoryView.css";

type TimelineEntry =
  | { kind: "commit"; item: OffChainCommit }
  | { kind: "anchor"; item: MergeAnchor };

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
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

function branchChipClass(branch: string): string {
  if (branch === "main")            return "green";
  if (branch.startsWith("hotfix/")) return "red";
  if (branch.startsWith("feat/"))   return "blue";
  if (branch.startsWith("explore/"))return "orange";
  if (branch.startsWith("dev/"))    return "purple";
  return "muted";
}

export default function HistoryView() {
  const orderedCommits = useDagStore((s) => s.orderedCommits);
  const orderedAnchors = useDagStore((s) => s.orderedAnchors);
  const proposals      = useDagStore((s) => s.proposals);
  const activeBranch   = useUiStore((s) => s.activeBranch);
  const panel          = useUiStore((s) => s.panel);
  const openAnchor     = useUiStore((s) => s.openAnchor);
  const replayActive   = useUiStore((s) => s.replayActive);
  const replayIndex    = useUiStore((s) => s.replayIndex);

  const selectedId = panel?.kind === "anchor" ? panel.anchor.id : null;

  const timeline = useMemo((): TimelineEntry[] => {
    const commits: TimelineEntry[] = orderedCommits
      .filter((c) => !activeBranch || c.branch === activeBranch)
      .map((c) => ({ kind: "commit", item: c }));

    const anchors: TimelineEntry[] = orderedAnchors
      .filter((a) => !activeBranch || a.branch === activeBranch)
      .map((a) => ({ kind: "anchor", item: a }));

    const merged = [...commits, ...anchors].sort((a, b) => a.item.ts_ms - b.item.ts_ms);

    const sliced = replayActive ? merged.slice(0, replayIndex) : merged;
    return [...sliced].reverse();
  }, [orderedCommits, orderedAnchors, activeBranch, replayActive, replayIndex]);

  if (timeline.length === 0) {
    return (
      <div className="history-empty">
        <p>No history{activeBranch ? ` on ${activeBranch}` : ""}.</p>
        <p className="history-empty-sub">
          Off-chain commits appear here when loaded via{" "}
          <code>memfork ui</code> (requires MemWal credentials).
          Merge settlements appear when finalized on-chain.
        </p>
      </div>
    );
  }

  const commitCount = timeline.filter((e) => e.kind === "commit").length;
  const anchorCount = timeline.filter((e) => e.kind === "anchor").length;

  return (
    <div className="history-view">
      <div className="history-header">
        <span className="history-header-count">
          {commitCount > 0 && `${commitCount} commit${commitCount !== 1 ? "s" : ""}`}
          {commitCount > 0 && anchorCount > 0 && " · "}
          {anchorCount > 0 && `${anchorCount} merge${anchorCount !== 1 ? "s" : ""}`}
        </span>
        {activeBranch && (
          <span className={`chip ${branchChipClass(activeBranch)}`}>{activeBranch}</span>
        )}
      </div>

      <ul className="history-list" role="listbox" aria-label="Branch history">
        {timeline.map((entry, i) => {
          const isFirst = i === 0;
          const isLast  = i === timeline.length - 1;

          if (entry.kind === "commit") {
            const c = entry.item;
            return (
              <li
                key={c.blob_id}
                className="history-row"
                title={absTime(c.ts_ms)}
              >
                <div className="history-gutter" aria-hidden="true">
                  <span className="history-line history-line-top"  style={{ visibility: isFirst ? "hidden" : "visible" }} />
                  <span className={`history-node branch-${branchChipClass(c.branch)}`} />
                  <span className="history-line history-line-bottom" style={{ visibility: isLast ? "hidden" : "visible" }} />
                </div>
                <div className="history-content">
                  <div className="history-top-row">
                    <code className="history-short-id">{c.blob_id.slice(0, 8)}</code>
                    <span className="history-message">{c.message}</span>
                  </div>
                  <div className="history-meta-row">
                    <span className={`chip ${branchChipClass(c.branch)}`}>{c.branch}</span>
                    <span className="history-sep" aria-hidden="true">·</span>
                    <span className="history-time">{relTime(c.ts_ms)}</span>
                    {c.parent_blob_ids.length > 1 && (
                      <span className="history-parents-hint">{c.parent_blob_ids.length} parents</span>
                    )}
                  </div>
                </div>
              </li>
            );
          }

          // Merge anchor
          const a = entry.item;
          const proposal = proposals.get(a.proposal_id);
          const isSelected = a.id === selectedId;

          return (
            <li
              key={a.id}
              role="option"
              aria-selected={isSelected}
              className={`history-row ${isSelected ? "selected" : ""}`}
              onClick={() => openAnchor(a)}
              tabIndex={isSelected ? 0 : -1}
              title={absTime(a.ts_ms)}
            >
              <div className="history-gutter" aria-hidden="true">
                <span className="history-line history-line-top"  style={{ visibility: isFirst ? "hidden" : "visible" }} />
                <span className="history-node merge" />
                <span className="history-line history-line-bottom" style={{ visibility: isLast ? "hidden" : "visible" }} />
              </div>
              <div className="history-content">
                <div className="history-top-row">
                  <code className="history-short-id">{a.id.slice(2, 9)}</code>
                  <span className="chip purple">MERGE</span>
                  <span className="chip green">ON-CHAIN</span>
                  <span className="history-message">
                    {proposal ? `${proposal.from_branch} → ${a.branch}` : `→ ${a.branch}`}
                  </span>
                </div>
                <div className="history-meta-row">
                  <span className={`chip ${branchChipClass(a.branch)}`}>{a.branch}</span>
                  <span className="history-sep" aria-hidden="true">·</span>
                  <span className="history-time">{relTime(a.ts_ms)}</span>
                  <span className="history-parents-hint">settled ◈</span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
