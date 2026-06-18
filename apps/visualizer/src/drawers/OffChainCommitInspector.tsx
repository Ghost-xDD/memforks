/**
 * OffChainCommitInspector — right-drawer panel for an off-chain Walrus commit.
 *
 * Shows everything knowable client-side: message, author/tool, branch, blob ID,
 * parent chain, fact keys changed (from delta), artifact refs, and a Walrus link.
 */

import { useState } from "react";
import type { OffChainCommit, ArtifactRef } from "../sui/types.js";
import { getWalrusBlobBase } from "../sui/client.js";
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

// ─── Artifact row ─────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ArtifactRow({ ref: artifact }: { ref: ArtifactRef }) {
  const [copied, setCopied] = useState(false);
  const blobBase = getWalrusBlobBase();
  const downloadUrl = `${blobBase}/${artifact.blobId}`;
  const shortBlob = artifact.blobId.replace(/^0x/, "").slice(0, 20);

  function copyBlobId() {
    navigator.clipboard.writeText(artifact.blobId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    }).catch(() => {});
  }

  return (
    <li className="inspector-parent-row" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "6px", justifyContent: "space-between" }}>
        <span style={{ fontSize: "0.8rem", color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {artifact.path}
        </span>
        <span style={{ fontSize: "0.7rem", color: "var(--fg-3)", flexShrink: 0 }}>
          {formatBytes(artifact.size)}
          {artifact.mime ? ` · ${artifact.mime}` : ""}
        </span>
      </div>
      <div style={{ display: "flex", gap: "6px" }}>
        <button
          className="inspector-copy-row"
          style={{ flex: 1 }}
          onClick={copyBlobId}
          title="Copy blob ID"
        >
          <span className="inspector-link-icon">⬡</span>
          <code className="inspector-mono-sm">{shortBlob}…</code>
          <span className="inspector-copy-badge">{copied ? "✓" : "copy"}</span>
        </button>
        <a
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inspector-link inspector-link-sm"
          title="Open on Walrus aggregator"
        >
          <span className="inspector-link-icon">↗</span>
          view
        </a>
      </div>
    </li>
  );
}

export default function OffChainCommitInspector({ commit }: Props) {
  const [copied, setCopied] = useState(false);
  const blobHex    = commit.blob_id.replace(/^0x/, "");

  function copyBlobId() {
    navigator.clipboard.writeText(commit.blob_id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    }).catch(() => {});
  }
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

      {/* Artifacts — plaintext Walrus blobs; browser-downloadable */}
      {commit.artifacts && commit.artifacts.length > 0 && (
        <section className="inspector-section">
          <p className="inspector-section-label">
            Artifacts ({commit.artifacts.length})
          </p>
          <ul className="inspector-parents">
            {commit.artifacts.map((a) => (
              <ArtifactRow key={a.blobId} ref={a} />
            ))}
          </ul>
          <p className="inspector-snapshot-hint">
            Plaintext · stored on Walrus · public read
          </p>
        </section>
      )}

      {/* Blob ID — copy only, not a link (SEAL-encrypted, not browser-readable) */}
      <section className="inspector-section">
        <p className="inspector-section-label">Blob ID</p>
        <button
          className="inspector-copy-row"
          onClick={copyBlobId}
          title="Copy full blob ID"
        >
          <span className="inspector-link-icon">⬡</span>
          <code className="inspector-mono-sm">{blobHex.slice(0, 24)}…</code>
          <span className="inspector-copy-badge">{copied ? "✓ copied" : "copy"}</span>
        </button>
        <p className="inspector-snapshot-hint">
          SEAL-encrypted · stored on Walrus · not browser-readable
        </p>
      </section>
    </div>
  );
}
