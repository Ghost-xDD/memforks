"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RecalledFact } from "@/lib/memfork";
import styles from "./diff-panel.module.css";

interface DiffResult {
  from: RecalledFact[];
  into: RecalledFact[];
  query: string;
}

interface Props {
  fromBranch: string;
  intoBranch: string;
  onClose: () => void;
  onMerge: () => void;
  isMerging: boolean;
  mergeError?: string | null;
}

function isShared(fact: RecalledFact, others: RecalledFact[]): boolean {
  const norm = (s: string) => s.trim().toLowerCase().slice(0, 200);
  return others.some((o) => norm(o.text) === norm(fact.text));
}

export function DiffPanel({ fromBranch, intoBranch, onClose, onMerge, isMerging, mergeError }: Props) {
  const [query, setQuery] = useState("facts about this project conversation and user");
  const [draft, setDraft] = useState(query);
  const [result, setResult] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchDiff = useCallback(
    async (q: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/diff?from=${encodeURIComponent(fromBranch)}&into=${encodeURIComponent(intoBranch)}&query=${encodeURIComponent(q)}`,
        );
        const data = (await res.json()) as DiffResult & { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Diff failed");
        setResult(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load diff");
      } finally {
        setLoading(false);
      }
    },
    [fromBranch, intoBranch],
  );

  useEffect(() => {
    void fetchDiff(query);
  }, [fetchDiff, query]);

  const handleQuery = (e: React.FormEvent) => {
    e.preventDefault();
    const q = draft.trim();
    if (!q || q === query) return;
    setQuery(q);
  };

  const fromUnique = result ? result.from.filter((f) => !isShared(f, result.into)) : [];
  const intoUnique = result ? result.into.filter((f) => !isShared(f, result.from)) : [];
  const shared = result ? result.from.filter((f) => isShared(f, result.into)) : [];

  return (
    <div className={styles.overlay} role="dialog" aria-modal aria-label="Branch memory diff">
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div className={styles.panelTitle}>
            <span className={styles.panelIcon} aria-hidden>
              ⑂
            </span>
            <span>Memory diff</span>
          </div>
          <div className={styles.branchLabels}>
            <span className={styles.branchChip} data-side="from">
              {fromBranch}
            </span>
            <span className={styles.arrow}>→</span>
            <span className={styles.branchChip} data-side="into">
              {intoBranch}
            </span>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close diff panel">
            ✕
          </button>
        </div>

        <form className={styles.queryBar} onSubmit={handleQuery}>
          <input
            ref={inputRef}
            className={styles.queryInput}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Query both branches…"
          />
          <button type="submit" className={styles.refreshBtn} disabled={loading}>
            {loading ? "…" : "Refresh"}
          </button>
        </form>

        {error && <p className={styles.errorMsg}>{error}</p>}

        {result && !loading && (
          <>
            <div className={styles.stats}>
              <span className={styles.statUnique} data-side="from">
                {fromUnique.length} unique to {fromBranch}
              </span>
              <span className={styles.statShared}>{shared.length} shared</span>
              <span className={styles.statUnique} data-side="into">
                {intoUnique.length} unique to {intoBranch}
              </span>
            </div>

            <div className={styles.columns}>
              <div className={styles.column}>
                <p className={styles.columnLabel} data-side="from">
                  {fromBranch}
                </p>
                {result.from.length === 0 ? (
                  <p className={styles.empty}>No facts recalled</p>
                ) : (
                  result.from.map((f, i) => (
                    <div
                      key={i}
                      className={`${styles.fact} ${isShared(f, result.into) ? styles.factShared : styles.factUnique}`}
                    >
                      <span className={styles.factBadge}>
                        {isShared(f, result.into) ? "shared" : "unique"}
                      </span>
                      <p className={styles.factText}>{f.text}</p>
                      <span className={styles.distance}>{f.distance.toFixed(3)}</span>
                    </div>
                  ))
                )}
              </div>

              <div className={styles.divider} />

              <div className={styles.column}>
                <p className={styles.columnLabel} data-side="into">
                  {intoBranch}
                </p>
                {result.into.length === 0 ? (
                  <p className={styles.empty}>No facts recalled</p>
                ) : (
                  result.into.map((f, i) => (
                    <div
                      key={i}
                      className={`${styles.fact} ${isShared(f, result.from) ? styles.factShared : styles.factUnique}`}
                    >
                      <span className={styles.factBadge}>
                        {isShared(f, result.from) ? "shared" : "unique"}
                      </span>
                      <p className={styles.factText}>{f.text}</p>
                      <span className={styles.distance}>{f.distance.toFixed(3)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}

        {loading && (
          <div className={styles.loadingWrap}>
            <span className={styles.loadingDots}>
              <span /><span /><span />
            </span>
            <p>Recalling from both branches…</p>
          </div>
        )}

        <div className={styles.panelFooter}>
          <p className={mergeError ? styles.footerError : styles.footerHint}>
            {mergeError ?? `Merging commits ${fromBranch}'s recalled facts as a new blob on ${intoBranch}.`}
          </p>
          <button
            className={styles.mergeBtn}
            onClick={onMerge}
            disabled={isMerging || loading}
          >
            {isMerging ? "Merging…" : `Merge ${fromBranch} → ${intoBranch}`}
          </button>
        </div>
      </div>
    </div>
  );
}
