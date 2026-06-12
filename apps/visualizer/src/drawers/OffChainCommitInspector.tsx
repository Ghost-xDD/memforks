/**
 * OffChainCommitInspector — right-drawer panel for an off-chain Walrus commit.
 *
 * Shows everything knowable client-side: message, author/tool, branch, blob ID,
 * parent chain, fact keys changed (from delta), and a Walrus link.
 */

import type { OffChainCommit } from "../sui/types.js";
import { WALRUS_BLOB_BASE } from "../sui/client.js";
import "./Inspector.css";

interface Props {
  commit: OffChainCommit;
}

const TOOL_LABEL: Record<string, string> = {
  codex:  "Codex",
  cursor: "Cursor",
  sdk:    "SDK",
};

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
  return new Date(ms).toLocaleString();
}

export default function OffChainCommitInspector({ commit }: Props) {
  const blobHex    = commit.blob_id.replace(/^0x/, "");
  const deltaKeys  = Object.keys(commit.delta ?? {});
  const toolLabel  = commit.tool ? TOOL_LABEL[commit.tool] ?? commit.tool : null;

  return (
    <div className="inspector">
      {/* Header */}
      <div className="inspector-header">
        <div className="inspector-title-row">
          <code className="inspector-commit-id">{blobHex.slice(0, 8)}…</code>
          <span className="chip muted">commit</span>
          {commit.tool && (
            <span className="chip muted">{toolLabel}</span>
          )}
        </div>
        <p className="inspector-message">{commit.message}</p>
      </div>

      {/* Meta */}
      <section className="inspector-section">
        <div className="inspector-kv">
          <span className="inspector-key">Branch</span>
          <code className="inspector-val">{commit.branch}</code>
        </div>
        {commit.author && (
          <div className="inspector-kv">
            <span className="inspector-key">Author</span>
            <span className="inspector-val">{commit.author}</span>
          </div>
        )}
        <div className="inspector-kv">
          <span className="inspector-key">Time</span>
          <span className="inspector-val" title={absTime(commit.ts_ms)}>
            {relTime(commit.ts_ms)}
          </span>
        </div>
        <div className="inspector-kv">
          <span className="inspector-key">Storage</span>
          <span className="inspector-val inspector-mono-sm">Off-chain · Walrus</span>
        </div>
      </section>

      {/* Delta — keys changed */}
      {deltaKeys.length > 0 && (
        <section className="inspector-section">
          <p className="inspector-section-label">
            Keys changed ({deltaKeys.length})
          </p>
          <ul className="inspector-parents">
            {deltaKeys.map((k) => (
              <li key={k} className="inspector-parent-row">
                <code className="inspector-mono-sm">{k}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Parent chain */}
      {commit.parent_blob_ids.length > 0 && (
        <section className="inspector-section">
          <p className="inspector-section-label">Parent blob</p>
          {commit.parent_blob_ids.map((pid, i) => (
            <code key={i} className="inspector-code-block">
              {pid ? pid.replace(/^0x/, "").slice(0, 32) + "…" : "(genesis)"}
            </code>
          ))}
        </section>
      )}

      {/* Walrus link */}
      <section className="inspector-section">
        <p className="inspector-section-label">Blob</p>
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
      </section>

      {/* Off-chain note */}
      <section className="inspector-section inspector-snapshot">
        <p className="inspector-snapshot-hint">
          This commit is stored off-chain as a Walrus blob. Content is encrypted
          with the branch's MemWal key and not visible in the browser.
        </p>
      </section>
    </div>
  );
}
