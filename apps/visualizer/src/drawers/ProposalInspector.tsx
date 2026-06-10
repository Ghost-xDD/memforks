/**
 * ProposalInspector — shows a MergeProposal's status, attestations, and links.
 */

import type { MergeProposal } from "../sui/types.js";
import { ATTEST_KIND } from "../sui/types.js";
import { useDagStore } from "../state/dagStore.js";
import { useUiStore } from "../state/uiStore.js";
import { SUI_EXPLORER_BASE } from "../sui/client.js";
import "./Inspector.css";

interface Props {
  proposal: MergeProposal;
}

const STATUS_CHIP: Record<string, string> = {
  pending:   "orange",
  finalized: "green",
  aborted:   "red",
  expired:   "muted",
};

function shortAddr(addr: string): string {
  return addr.slice(0, 8) + "…" + addr.slice(-4);
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function ProposalInspector({ proposal }: Props) {
  const mergeAnchors = useDagStore((s) => s.mergeAnchors);
  const openAnchor   = useUiStore((s)  => s.openAnchor);

  const mergeAnchor = proposal.merge_commit_id
    ? mergeAnchors.get(proposal.merge_commit_id)
    : null;

  return (
    <div className="inspector">
      {/* Header */}
      <div className="inspector-header">
        <div className="inspector-title-row">
          <code className="inspector-commit-id">{proposal.id.slice(2, 9)}…</code>
          <span className={`chip ${STATUS_CHIP[proposal.status] ?? "muted"}`}>
            {proposal.status.toUpperCase()}
          </span>
        </div>
        <p className="inspector-message">
          Merge <strong>{proposal.from_branch}</strong> → <strong>{proposal.into_branch}</strong>
        </p>
      </div>

      {/* Meta */}
      <section className="inspector-section">
        <div className="inspector-kv">
          <span className="inspector-key">From</span>
          <code className="inspector-val">{proposal.from_branch}</code>
        </div>
        <div className="inspector-kv">
          <span className="inspector-key">Into</span>
          <code className="inspector-val">{proposal.into_branch}</code>
        </div>
        <div className="inspector-kv">
          <span className="inspector-key">Proposer</span>
          <code className="inspector-val" title={proposal.proposer}>{shortAddr(proposal.proposer)}</code>
        </div>
        <div className="inspector-kv">
          <span className="inspector-key">Opened</span>
          <span className="inspector-val">{relTime(proposal.ts_ms)}</span>
        </div>
        <div className="inspector-kv">
          <span className="inspector-key">Resolver</span>
          <code className="inspector-val inspector-mono-sm" title={proposal.resolver_id}>
            {proposal.resolver_id.slice(2, 10)}…
          </code>
        </div>
      </section>

      {/* Attestations */}
      <section className="inspector-section">
        <p className="inspector-section-label">
          Attestations ({proposal.attestations.length})
        </p>
        {proposal.attestations.length === 0 ? (
          <p className="inspector-empty-hint">Waiting for jury workers…</p>
        ) : (
          <ul className="inspector-attestations">
            {proposal.attestations.map((a, i) => (
              <li key={i} className="inspector-attest-row">
                <div className="inspector-attest-top">
                  <span className={`chip ${a.kind === 0x04 ? "purple" : "green"}`}>
                    {ATTEST_KIND[a.kind] ?? `0x${a.kind.toString(16)}`}
                  </span>
                  <code className="inspector-attest-signer" title={a.signer}>
                    {shortAddr(a.signer)}
                  </code>
                  <span className="inspector-attest-time">{relTime(a.ts_ms)}</span>
                </div>
                <a
                  className="inspector-link inspector-link-sm"
                  href={`${SUI_EXPLORER_BASE}/${a.tx_digest}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  Sui tx <code>{a.tx_digest.slice(0, 12)}…</code>
                  <span className="inspector-link-ext">↗</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Blob IDs recorded in the proposal */}
      <section className="inspector-section">
        <p className="inspector-section-label">Branch tips at proposal time</p>
        <div className="inspector-kv">
          <span className="inspector-key">from_head</span>
          <code className="inspector-val inspector-mono-sm" title={proposal.from_head_blob_id}>
            {proposal.from_head_blob_id ? proposal.from_head_blob_id.slice(0, 16) + "…" : "(genesis)"}
          </code>
        </div>
        <div className="inspector-kv">
          <span className="inspector-key">into_head</span>
          <code className="inspector-val inspector-mono-sm" title={proposal.into_head_blob_id}>
            {proposal.into_head_blob_id ? proposal.into_head_blob_id.slice(0, 16) + "…" : "(genesis)"}
          </code>
        </div>
      </section>

      {/* Merge anchor link */}
      {mergeAnchor && (
        <section className="inspector-section">
          <p className="inspector-section-label">Merge anchor</p>
          <button
            className="inspector-parent-btn"
            onClick={() => openAnchor(mergeAnchor)}
          >
            <code>{mergeAnchor.id.slice(2, 9)}</code>
            <span className="inspector-parent-branch">{mergeAnchor.branch}</span>
            <span className="inspector-parent-arrow">↗</span>
          </button>
        </section>
      )}

      {/* On-chain link */}
      <section className="inspector-section">
        <p className="inspector-section-label">On-chain</p>
        <a
          className="inspector-link"
          href={`${SUI_EXPLORER_BASE}/${proposal.tx_digest}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="inspector-link-icon">◈</span>
          Proposal tx <code>{proposal.tx_digest.slice(0, 12)}…</code>
          <span className="inspector-link-ext">↗</span>
        </a>
      </section>
    </div>
  );
}
