/**
 * HistoryView — linear merge anchor log, newest-first.
 *
 * Model A: shows merge anchors (on-chain settlements). Off-chain commits between
 * merges are represented by the resolved blob ID linked to the Walrus aggregator.
 * Click a row to open the AnchorInspector.
 */

import { useMemo } from "react";
import { useDagStore } from "../../state/dagStore.js";
import { useUiStore } from "../../state/uiStore.js";
import "./HistoryView.css";

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
  const orderedAnchors = useDagStore((s) => s.orderedAnchors);
  const proposals      = useDagStore((s) => s.proposals);
  const activeBranch   = useUiStore((s) => s.activeBranch);
  const panel          = useUiStore((s) => s.panel);
  const openAnchor     = useUiStore((s) => s.openAnchor);
  const replayActive   = useUiStore((s) => s.replayActive);
  const replayIndex    = useUiStore((s) => s.replayIndex);

  const selectedId = panel?.kind === "anchor" ? panel.anchor.id : null;

  const anchors = useMemo(() => {
    const source = replayActive ? orderedAnchors.slice(0, replayIndex) : orderedAnchors;
    const all    = [...source].reverse();
    return activeBranch ? all.filter((a) => a.branch === activeBranch) : all;
  }, [orderedAnchors, activeBranch, replayActive, replayIndex]);

  const proposalByAnchor = useMemo(() => {
    const m = new Map<string, string>(); // merge_commit_id → status
    for (const p of proposals.values()) {
      if (p.merge_commit_id) m.set(p.merge_commit_id, p.status);
    }
    return m;
  }, [proposals]);

  if (anchors.length === 0) {
    return (
      <div className="history-empty">
        <p>No merge anchors{activeBranch ? ` on ${activeBranch}` : ""}.</p>
        <p className="history-empty-sub">Off-chain commits are stored in Walrus blobs — merges appear here when settled on-chain.</p>
      </div>
    );
  }

  return (
    <div className="history-view">
      <div className="history-header">
        <span className="history-header-count">{anchors.length} merge anchor{anchors.length !== 1 ? "s" : ""}</span>
        {activeBranch && (
          <span className={`chip ${branchChipClass(activeBranch)}`}>{activeBranch}</span>
        )}
      </div>

      <ul className="history-list" role="listbox" aria-label="Merge anchor history">
        {anchors.map((anchor, i) => {
          const isFirst    = i === 0;
          const isLast     = i === anchors.length - 1;
          const isSelected = anchor.id === selectedId;
          const proposal   = proposals.get(anchor.proposal_id);
          const statusBadge = proposalByAnchor.get(anchor.id);

          return (
            <li
              key={anchor.id}
              role="option"
              aria-selected={isSelected}
              className={`history-row ${isSelected ? "selected" : ""}`}
              onClick={() => openAnchor(anchor)}
              tabIndex={isSelected ? 0 : -1}
              title={absTime(anchor.ts_ms)}
            >
              {/* Gutter */}
              <div className="history-gutter" aria-hidden="true">
                <span className="history-line history-line-top"  style={{ visibility: isFirst ? "hidden" : "visible" }} />
                <span className="history-node merge" />
                <span className="history-line history-line-bottom" style={{ visibility: isLast ? "hidden" : "visible" }} />
              </div>

              {/* Content */}
              <div className="history-content">
                <div className="history-top-row">
                  <code className="history-short-id">{anchor.id.slice(2, 9)}</code>
                  <span className="chip purple">MERGE</span>
                  {statusBadge === "finalized" && <span className="chip green">APPROVED</span>}
                  <span className="history-message">
                    {proposal
                      ? `${proposal.from_branch} → ${anchor.branch}`
                      : `→ ${anchor.branch}`}
                  </span>
                </div>
                <div className="history-meta-row">
                  <span className={`chip ${branchChipClass(anchor.branch)}`}>{anchor.branch}</span>
                  <span className="history-sep" aria-hidden="true">·</span>
                  <span className="history-time">{relTime(anchor.ts_ms)}</span>
                  {anchor.parents.length > 0 && (
                    <span className="history-parents-hint">
                      {anchor.parents.length} blobs consumed
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
