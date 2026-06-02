/**
 * HistoryView — linear commit log, newest-first.
 *
 * Click a row to open the CommitInspector. Shift+click for range selection
 * (future: range diff). Branch filter from the top bar is respected.
 */

import { useMemo } from "react";
import { useDagStore } from "../../state/dagStore.js";
import { useUiStore } from "../../state/uiStore.js";
import { COMMIT_MESSAGES } from "../../seed/demo.js";
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

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function branchChipClass(branch: string): string {
  if (branch === "main")             return "green";
  if (branch.startsWith("hotfix/"))  return "red";
  if (branch.startsWith("feat/"))    return "blue";
  if (branch.startsWith("explore/")) return "orange";
  if (branch.startsWith("dev/"))     return "purple";
  return "muted";
}

export default function HistoryView() {
  const orderedCommits = useDagStore((s) => s.orderedCommits);
  const proposals      = useDagStore((s) => s.proposals);
  const activeBranch   = useUiStore((s) => s.activeBranch);
  const panel          = useUiStore((s) => s.panel);
  const openCommit     = useUiStore((s) => s.openCommit);
  const replayActive   = useUiStore((s) => s.replayActive);
  const replayIndex    = useUiStore((s) => s.replayIndex);

  const selectedId = panel?.kind === "commit" ? panel.commit.id : null;

  // Newest-first, filtered by active branch. In replay mode, slice to replayIndex.
  const commits = useMemo(() => {
    const source = replayActive ? orderedCommits.slice(0, replayIndex) : orderedCommits;
    const all    = [...source].reverse();
    return activeBranch ? all.filter((c) => c.branch === activeBranch) : all;
  }, [orderedCommits, activeBranch, replayActive, replayIndex]);

  // Build a map of proposal_id → proposal for quick lookup on merge commits.
  const proposalByMergeCommit = useMemo(() => {
    const m = new Map<string, string>(); // merge_commit_id → proposal status
    for (const p of proposals.values()) {
      if (p.merge_commit_id) m.set(p.merge_commit_id, p.status);
    }
    return m;
  }, [proposals]);

  if (commits.length === 0) {
    return (
      <div className="history-empty">
        <p>No commits{activeBranch ? ` on ${activeBranch}` : ""}.</p>
      </div>
    );
  }

  return (
    <div className="history-view">
      <div className="history-header">
        <span className="history-header-count">{commits.length} commits</span>
        {activeBranch && (
          <span className={`chip ${branchChipClass(activeBranch)}`}>{activeBranch}</span>
        )}
      </div>

      <ul className="history-list" role="listbox" aria-label="Commit history">
        {commits.map((commit, i) => {
          const isFirst    = i === 0;
          const isLast     = i === commits.length - 1;
          const isSelected = commit.id === selectedId;
          const msg = commit.message
            ?? COMMIT_MESSAGES[commit.id.replace(/^0x/, "")]
            ?? `commit ${commit.short_id}`;
          const mergeProposalStatus = proposalByMergeCommit.get(commit.id);

          return (
            <li
              key={commit.id}
              role="option"
              aria-selected={isSelected}
              className={`history-row ${isSelected ? "selected" : ""}`}
              onClick={() => openCommit({ ...commit, message: msg })}
              tabIndex={isSelected ? 0 : -1}
              title={absTime(commit.ts_ms)}
            >
              {/* Gutter — vertical line + node */}
              <div className="history-gutter" aria-hidden="true">
                <span
                  className="history-line history-line-top"
                  style={{ visibility: isFirst ? "hidden" : "visible" }}
                />
                <span
                  className={`history-node ${commit.is_merge ? "merge" : ""} branch-${branchChipClass(commit.branch)}`}
                />
                <span
                  className="history-line history-line-bottom"
                  style={{ visibility: isLast ? "hidden" : "visible" }}
                />
              </div>

              {/* Content */}
              <div className="history-content">
                <div className="history-top-row">
                  <code className="history-short-id">{commit.short_id}</code>
                  {commit.is_merge && <span className="chip purple">MERGE</span>}
                  {mergeProposalStatus === "finalized" && (
                    <span className="chip green">JURY ✓</span>
                  )}
                  <span className="history-message" title={msg}>{msg}</span>
                </div>
                <div className="history-meta-row">
                  <span className={`chip ${branchChipClass(commit.branch)}`}>
                    {commit.branch}
                  </span>
                  <span className="history-author">{shortAddr(commit.author)}</span>
                  <span className="history-sep" aria-hidden="true">·</span>
                  <span className="history-time">{relTime(commit.ts_ms)}</span>
                  {commit.parents.length > 1 && (
                    <span className="history-parents-hint">
                      {commit.parents.length} parents
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
