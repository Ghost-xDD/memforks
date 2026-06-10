/**
 * AnchorInspector — right-drawer panel for an on-chain merge anchor.
 *
 * Model A: shows the resolved blob ID (Walrus link), the merge proposal that
 * produced this anchor, parent blob IDs (the branch tips consumed), and the
 * Sui tx link for the finalize_merge call.
 */

import type { MergeAnchor } from "../sui/types.js";
import { useDagStore } from "../state/dagStore.js";
import { useUiStore } from "../state/uiStore.js";
import { SUI_EXPLORER_BASE, WALRUS_BLOB_BASE } from "../sui/client.js";
import "./Inspector.css";

interface Props {
  anchor: MergeAnchor;
}

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
  return new Date(ms).toLocaleString();
}

export default function CommitInspector({ anchor }: Props) {
  const proposals    = useDagStore((s) => s.proposals);
  const openProposal = useUiStore((s)  => s.openProposal);

  const relatedProposal = proposals.get(anchor.proposal_id);

  const resolvedBlobHex = anchor.resolved_blob_id.replace(/^0x/, "");

  return (
    <div className="inspector">
      {/* Header */}
      <div className="inspector-header">
        <div className="inspector-title-row">
          <code className="inspector-commit-id">{anchor.id.slice(2, 9)}</code>
          <span className="chip purple">MERGE ANCHOR</span>
          <span className={`chip ${branchChipClass(anchor.branch)}`}>{anchor.branch}</span>
        </div>
        <p className="inspector-message">
          On-chain settlement: resolved content anchored at blob{" "}
          <code>{resolvedBlobHex.slice(0, 12)}…</code>
        </p>
      </div>

      {/* Meta */}
      <section className="inspector-section">
        <div className="inspector-kv">
          <span className="inspector-key">Branch</span>
          <code className="inspector-val">{anchor.branch}</code>
        </div>
        <div className="inspector-kv">
          <span className="inspector-key">Time</span>
          <span className="inspector-val" title={absTime(anchor.ts_ms)}>{relTime(anchor.ts_ms)}</span>
        </div>
        <div className="inspector-kv">
          <span className="inspector-key">Anchor ID</span>
          <code className="inspector-val inspector-mono-sm" title={anchor.id}>
            {anchor.id.slice(0, 20)}…
          </code>
        </div>
      </section>

      {/* Parent blob IDs (branch tips consumed by merge) */}
      {anchor.parents.length > 0 && (
        <section className="inspector-section">
          <p className="inspector-section-label">Branch tips consumed</p>
          <ul className="inspector-parents">
            {anchor.parents.map((blobId, i) => (
              <li key={i} className="inspector-parent-row">
                <code className="inspector-mono-sm">
                  {blobId ? blobId.slice(0, 20) + "…" : "(genesis)"}
                </code>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* On-chain + Walrus links */}
      <section className="inspector-section">
        <p className="inspector-section-label">On-chain</p>
        <a
          className="inspector-link"
          href={`${SUI_EXPLORER_BASE}/${anchor.tx_digest}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="inspector-link-icon">◈</span>
          Sui tx <code>{anchor.tx_digest.slice(0, 12)}…</code>
          <span className="inspector-link-ext">↗</span>
        </a>
        {resolvedBlobHex && (
          <a
            className="inspector-link"
            href={`${WALRUS_BLOB_BASE}/${resolvedBlobHex}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="inspector-link-icon">⬡</span>
            Resolved blob <code>{resolvedBlobHex.slice(0, 12)}…</code>
            <span className="inspector-link-ext">↗</span>
          </a>
        )}
      </section>

      {/* Merge proposal summary */}
      {relatedProposal && (
        <section className="inspector-section">
          <p className="inspector-section-label">Resolved via proposal</p>
          <div className="inspector-proposal-summary">
            <div className="inspector-kv">
              <span className="inspector-key">Proposal</span>
              <code className="inspector-val">{relatedProposal.id.slice(2, 9)}…</code>
            </div>
            <div className="inspector-kv">
              <span className="inspector-key">From branch</span>
              <code className="inspector-val">{relatedProposal.from_branch}</code>
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
          <button
            className="inspector-link"
            style={{ background: "none", border: "none", cursor: "pointer", padding: 0, width: "100%", textAlign: "left" }}
            onClick={() => openProposal(relatedProposal)}
          >
            <span className="inspector-link-icon">◈</span>
            View full proposal
            <span className="inspector-link-ext">→</span>
          </button>
        </section>
      )}

      {/* Off-chain history hint */}
      <section className="inspector-section inspector-snapshot">
        <p className="inspector-section-label">Off-chain commit history</p>
        <p className="inspector-snapshot-hint">
          Walk the Walrus blob hash chain from the resolved blob to reconstruct all
          off-chain commits since the previous merge. Requires MemWal read access.
        </p>
      </section>
    </div>
  );
}

function branchChipClass(branch: string): string {
  if (branch === "main")            return "green";
  if (branch.startsWith("hotfix/")) return "red";
  if (branch.startsWith("feat/"))   return "blue";
  if (branch.startsWith("explore/"))return "orange";
  if (branch.startsWith("dev/"))    return "purple";
  return "muted";
}
