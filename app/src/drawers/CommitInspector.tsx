/**
 * CommitInspector — right-drawer panel showing full MemoryCommit details.
 *
 * Shows: short_id, branch, author, timestamp, parents, Sui tx link,
 * Walrus blob link, and the memory snapshot message.
 */

import type { MemoryCommit } from "../sui/types.js";
import { useDagStore } from "../state/dagStore.js";
import { useUiStore } from "../state/uiStore.js";
import { SUI_EXPLORER_BASE, WALRUS_BLOB_BASE } from "../sui/client.js";
import { COMMIT_MESSAGES } from "../seed/demo.js";
import "./Inspector.css";

interface Props {
  commit: MemoryCommit;
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60)   return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30)   return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

function absTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function shortAddr(addr: string): string {
  return addr.slice(0, 8) + "…" + addr.slice(-4);
}

export default function CommitInspector({ commit }: Props) {
  const proposals      = useDagStore((s) => s.proposals);
  const orderedCommits = useDagStore((s) => s.orderedCommits);
  const openCommit     = useUiStore((s) => s.openCommit);

  const message = commit.message ?? COMMIT_MESSAGES[commit.id.replace(/^0x/, "")] ?? `commit ${commit.short_id}`;

  const blobHex = Array.isArray(commit.memwal_blob_id)
    ? (commit.memwal_blob_id as number[]).map((b) => b.toString(16).padStart(2, "0")).join("")
    : String(commit.memwal_blob_id);

  // Find related merge proposal.
  const relatedProposal = Array.from(proposals.values()).find(
    (p) => p.merge_commit_id === commit.id,
  );

  // Resolve parent commits for display.
  const parentCommits = commit.parents.map((pid) =>
    orderedCommits.find((c) => c.id === pid),
  );

  const isMerge = commit.is_merge;

  return (
    <div className="inspector">
      {/* Header */}
      <div className="inspector-header">
        <div className="inspector-title-row">
          <code className="inspector-commit-id">{commit.short_id}</code>
          {isMerge && <span className="chip purple">MERGE</span>}
          <span className={`chip ${branchChipClass(commit.branch)}`}>{commit.branch}</span>
        </div>
        <p className="inspector-message">{message}</p>
      </div>

      {/* Meta grid */}
      <section className="inspector-section">
        <div className="inspector-kv">
          <span className="inspector-key">Author</span>
          <code className="inspector-val" title={commit.author}>{shortAddr(commit.author)}</code>
        </div>
        <div className="inspector-kv">
          <span className="inspector-key">Time</span>
          <span className="inspector-val" title={absTime(commit.ts_ms)}>{relTime(commit.ts_ms)}</span>
        </div>
        <div className="inspector-kv">
          <span className="inspector-key">Branch</span>
          <code className="inspector-val">{commit.branch}</code>
        </div>
        <div className="inspector-kv">
          <span className="inspector-key">Commit ID</span>
          <code className="inspector-val inspector-mono-sm" title={commit.id}>
            {commit.id.slice(0, 20)}…
          </code>
        </div>
      </section>

      {/* Parents */}
      {parentCommits.length > 0 && (
        <section className="inspector-section">
          <p className="inspector-section-label">
            {isMerge ? `${parentCommits.length} Parents (merge)` : "Parent"}
          </p>
          <ul className="inspector-parents">
            {parentCommits.map((p) =>
              p ? (
                <li key={p.id} className="inspector-parent-row">
                  <button
                    className="inspector-parent-btn"
                    onClick={() => openCommit(p)}
                    title={`Go to ${p.short_id} on ${p.branch}`}
                  >
                    <code>{p.short_id}</code>
                    <span className="inspector-parent-branch">{p.branch}</span>
                    <span className="inspector-parent-arrow">↗</span>
                  </button>
                </li>
              ) : null,
            )}
          </ul>
        </section>
      )}

      {/* On-chain links */}
      <section className="inspector-section">
        <p className="inspector-section-label">On-chain</p>
        <a
          className="inspector-link"
          href={`${SUI_EXPLORER_BASE}/${commit.tx_digest}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="inspector-link-icon">◈</span>
          Sui tx <code>{commit.tx_digest.slice(0, 12)}…</code>
          <span className="inspector-link-ext">↗</span>
        </a>
        {blobHex && (
          <a
            className="inspector-link"
            href={`${WALRUS_BLOB_BASE}/${blobHex}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="inspector-link-icon">⬡</span>
            Walrus blob <code>{blobHex.slice(0, 12)}…</code>
            <span className="inspector-link-ext">↗</span>
          </a>
        )}
      </section>

      {/* MemWal namespace */}
      <section className="inspector-section">
        <p className="inspector-section-label">MemWal namespace</p>
        <code className="inspector-code-block">{commit.memwal_namespace}</code>
      </section>

      {/* Merge proposal summary */}
      {relatedProposal && (
        <section className="inspector-section">
          <p className="inspector-section-label">Resolved via</p>
          <div className="inspector-proposal-summary">
            <div className="inspector-kv">
              <span className="inspector-key">Proposal</span>
              <code className="inspector-val">{relatedProposal.id.slice(2, 9)}…</code>
            </div>
            <div className="inspector-kv">
              <span className="inspector-key">Verdict</span>
              <span className="chip green">APPROVED</span>
            </div>
            <div className="inspector-kv">
              <span className="inspector-key">Attestations</span>
              <span className="inspector-val">{relatedProposal.attestations.length} signers</span>
            </div>
          </div>
        </section>
      )}

      {/* Memory snapshot hint */}
      <section className="inspector-section inspector-snapshot">
        <p className="inspector-section-label">Memory snapshot</p>
        <div className="inspector-snapshot-body">
          <p>{message}</p>
        </div>
        <p className="inspector-snapshot-hint">
          Full content encrypted on Walrus — click the blob link above to inspect.
        </p>
      </section>
    </div>
  );
}

function branchChipClass(branch: string): string {
  if (branch === "main")              return "green";
  if (branch.startsWith("hotfix/"))   return "red";
  if (branch.startsWith("feat/"))     return "blue";
  if (branch.startsWith("explore/"))  return "orange";
  if (branch.startsWith("dev/"))      return "purple";
  return "muted";
}
