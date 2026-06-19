/**
 * MemoryView — default landing surface.
 *
 * Shows the materialized memory facts for the active branch (or all branches
 * merged LWW when no filter is active). Facts are grouped by their top-level
 * path prefix, searchable, and each links back to the introducing commit.
 */

import { useMemo, useState, useCallback } from "react";
import { useMemoryStore, type MemoryFact } from "../../state/memoryStore.js";
import { useUiStore } from "../../state/uiStore.js";
import { useDagStore } from "../../state/dagStore.js";
import TimeScrubber from "../../components/TimeScrubber.js";
import "./MemoryView.css";

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const d = Math.floor(diff / 86_400_000);
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30)  return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

export default function MemoryView() {
  const activeBranch  = useUiStore((s) => s.activeBranch);
  const openAnchor    = useUiStore((s) => s.openAnchor);
  const openCommit    = useUiStore((s) => s.openCommit);
  const mergeAnchors  = useDagStore((s) => s.mergeAnchors);
  const offChainCommits = useDagStore((s) => s.offChainCommits);
  const orderedCommits = useDagStore((s) => s.orderedCommits);
  const timeTravelIdx = useUiStore((s) => s.timeTravelIdx);
  const setTimeTravel = useUiStore((s) => s.setTimeTravel);
  // Subscribe to the facts map itself so we re-render when the store hydrates.
  const factsByBranch  = useMemoryStore((s) => s.facts);

  const [query, setQuery] = useState("");
  const [scrubberOpen, setScrubberOpen] = useState(false);
  const toggleScrubber = useCallback(() => setScrubberOpen((v) => !v), []);

  // Commits for the active branch (or all), oldest-first — used by the scrubber.
  const branchCommits = useMemo(
    () => orderedCommits.filter((c) => !activeBranch || c.branch === activeBranch),
    [orderedCommits, activeBranch],
  );

  const allFacts = useMemo(() => {
    if (activeBranch) return factsByBranch.get(activeBranch) ?? [];
    const merged = new Map<string, MemoryFact>();
    for (const list of factsByBranch.values()) {
      for (const f of list) merged.set(f.key, f);
    }
    return Array.from(merged.values()).sort((a, b) => a.key.localeCompare(b.key));
  }, [activeBranch, factsByBranch]);

  // Time-travel: when scrubbing, show only facts introduced up to cutIdx.
  const facts = useMemo(() => {
    if (timeTravelIdx === null) return allFacts;
    const cutCommit = branchCommits[timeTravelIdx];
    if (!cutCommit) return allFacts;
    const cutMs = cutCommit.ts_ms;
    return allFacts.filter((f) => f.ts_ms <= cutMs);
  }, [allFacts, timeTravelIdx, branchCommits]);

  const filtered = useMemo(() => {
    if (!query.trim()) return facts;
    const q = query.toLowerCase();
    return facts.filter(
      (f) =>
        f.content.toLowerCase().includes(q) ||
        (f.category ?? "").toLowerCase().includes(q) ||
        f.branch.toLowerCase().includes(q),
    );
  }, [facts, query]);

  // Group by human topic category; sort groups by size (richest first), then
  // alphabetically, with "General" always pinned to the bottom.
  const groups = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const f of filtered) {
      const cat = f.category ?? "General";
      const list = map.get(cat) ?? [];
      list.push(f);
      map.set(cat, list);
    }
    // Newest fact first within each group.
    for (const list of map.values()) list.sort((a, b) => b.ts_ms - a.ts_ms);
    return Array.from(map.entries()).sort(([a, la], [b, lb]) => {
      if (a === "General") return 1;
      if (b === "General") return -1;
      if (lb.length !== la.length) return lb.length - la.length;
      return a.localeCompare(b);
    });
  }, [filtered]);

  function handleFactClick(blobId: string) {
    // Prefer opening the off-chain commit drawer — most facts are introduced
    // by a regular memfork commit, not a merge anchor.
    const commit = offChainCommits.get(blobId);
    if (commit) { openCommit(commit); return; }
    // Fallback: find the merge anchor whose resolved blob or parent tip matches.
    const anchor = Array.from(mergeAnchors.values()).find(
      (a) => a.resolved_blob_id === blobId || a.parents.includes(blobId),
    );
    if (anchor) openAnchor(anchor);
  }

  const totalCount = facts.length;
  const branchLabel = activeBranch ?? "all branches";

  return (
    <div className="memory-view">
      {/* Search bar */}
      <div className="memory-search-row">
        <div className="memory-search-wrap">
          <svg className="memory-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="6.5" cy="6.5" r="5" />
            <line x1="10.5" y1="10.5" x2="14" y2="14" />
          </svg>
          <input
            className="memory-search"
            type="text"
            placeholder="Search memories…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {query && (
            <button className="memory-search-clear" onClick={() => setQuery("")} aria-label="Clear search">×</button>
          )}
        </div>
        <span className="memory-count-label">
          {totalCount} fact{totalCount !== 1 ? "s" : ""} · {branchLabel}
        </span>
        {branchCommits.length > 1 && (
          <button
            className={`memory-tt-btn${scrubberOpen ? " open" : ""}${timeTravelIdx !== null ? " active" : ""}`}
            onClick={toggleScrubber}
            title="Time-travel · view memory at any point in history"
            aria-label="Toggle time-travel scrubber"
            aria-pressed={scrubberOpen}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="8" cy="8" r="6" />
              <polyline points="8,4.5 8,8.5 10.5,10" />
              <path d="M4.5 2.5 A6 6 0 0 0 2 8" strokeWidth="1.5" />
              <polyline points="3,2 4.5,2.5 4,4" />
            </svg>
            {timeTravelIdx !== null && (
              <span className="memory-tt-badge" aria-hidden="true" />
            )}
          </button>
        )}
      </div>

      {/* Time-travel scrubber */}
      {branchCommits.length > 1 && (
        <TimeScrubber
          total={branchCommits.length}
          current={timeTravelIdx}
          onChange={setTimeTravel}
          commits={branchCommits}
          open={scrubberOpen}
        />
      )}

      {/* Empty state */}
      {groups.length === 0 && (
        <div className="memory-empty">
          {query
            ? <p>No facts match <strong>"{query}"</strong>.</p>
            : <p>No memory facts yet on <strong>{branchLabel}</strong>.</p>
          }
        </div>
      )}

      {/* Fact groups */}
      <div className="memory-groups">
        {groups.map(([category, groupFacts]) => (
          <section key={category} className="memory-group">
            <header
              className="memory-group-header"
              title={`${groupFacts.length} fact${groupFacts.length === 1 ? "" : "s"} about ${category}`}
            >
              <span className="memory-group-name">{category}</span>
              <span className="memory-group-count">
                {groupFacts.length} {groupFacts.length === 1 ? "fact" : "facts"}
              </span>
            </header>
            <ul className="memory-fact-list">
              {groupFacts.map((fact) => (
                <li
                  key={fact.key}
                  role="button"
                  tabIndex={0}
                  className="memory-fact-row"
                  onClick={() => handleFactClick(fact.introduced_by_id)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && handleFactClick(fact.introduced_by_id)}
                  title={`${fact.branch} · commit ${fact.introduced_by}`}
                >
                  <p className="memory-fact-content">{fact.content}</p>
                  <div className="memory-fact-meta-row">
                    {!activeBranch && (
                      <span className="memory-fact-branch">{fact.branch}</span>
                    )}
                    <span className="memory-fact-blob">#{fact.introduced_by}</span>
                    <span className="memory-fact-time">{relTime(fact.ts_ms)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
