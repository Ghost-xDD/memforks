/**
 * MemoryView — default landing surface.
 *
 * Shows the materialized memory facts for the active branch (or all branches
 * merged LWW when no filter is active). Facts are grouped by their top-level
 * path prefix, searchable, and each links back to the introducing commit.
 */

import { useMemo, useState } from "react";
import { useMemoryStore, type MemoryFact } from "../../state/memoryStore.js";
import { useUiStore } from "../../state/uiStore.js";
import { useDagStore } from "../../state/dagStore.js";
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
  const activeBranch = useUiStore((s) => s.activeBranch);
  const openAnchor   = useUiStore((s) => s.openAnchor);
  const mergeAnchors = useDagStore((s) => s.mergeAnchors);
  // Subscribe to the facts map itself so we re-render when the store hydrates.
  const factsByBranch  = useMemoryStore((s) => s.facts);

  const [query, setQuery] = useState("");

  const facts = useMemo(() => {
    if (activeBranch) return factsByBranch.get(activeBranch) ?? [];
    // Merge all branches — last-write-wins by key.
    const merged = new Map<string, MemoryFact>();
    for (const list of factsByBranch.values()) {
      for (const f of list) merged.set(f.key, f);
    }
    return Array.from(merged.values()).sort((a, b) => a.key.localeCompare(b.key));
  }, [activeBranch, factsByBranch]);

  const filtered = useMemo(() => {
    if (!query.trim()) return facts;
    const q = query.toLowerCase();
    return facts.filter(
      (f) =>
        f.key.toLowerCase().includes(q) ||
        f.content.toLowerCase().includes(q),
    );
  }, [facts, query]);

  // Group by top-level prefix (first segment before the first dot).
  const groups = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const f of filtered) {
      const prefix = f.key.split(".")[0];
      const list = map.get(prefix) ?? [];
      list.push(f);
      map.set(prefix, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  function handleFactClick(blobId: string) {
    // Find a merge anchor whose resolved_blob_id matches this blob ID.
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
      </div>

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
        {groups.map(([prefix, groupFacts]) => (
          <section key={prefix} className="memory-group">
            <header
              className="memory-group-header"
              title={`Facts with keys starting with "${prefix}.*"`}
            >
              <span className="memory-group-name">{prefix}</span>
              <span className="memory-group-count">
                {groupFacts.length} {groupFacts.length === 1 ? "fact" : "facts"}
              </span>
            </header>
            <ul className="memory-fact-list">
              {groupFacts.map((fact) => {
                const subKey = fact.key.slice(prefix.length + 1) || fact.key;
                return (
                  <li
                    key={fact.key}
                    role="button"
                    tabIndex={0}
                    className="memory-fact-row"
                    onClick={() => handleFactClick(fact.introduced_by_id)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && handleFactClick(fact.introduced_by_id)}
                    title={`${fact.branch} · commit ${fact.introduced_by}`}
                  >
                    <div className="memory-fact-key-row">
                      <code className="memory-fact-key">{subKey || fact.key}</code>
                      <span className="memory-fact-time">{relTime(fact.ts_ms)}</span>
                    </div>
                    <p className="memory-fact-content">{fact.content}</p>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
