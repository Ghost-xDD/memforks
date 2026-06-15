/**
 * MergesView — the Merges tab.
 *
 * Three sections:
 *   Active    — pending proposals rendered as live ceremony cards
 *   Settled   — finalized/aborted proposals as compact history rows
 *   Graveyard — branches that lost a merge; still queryable
 *
 * The ceremony card is the signature component: branch heads side-by-side,
 * attestation rows arriving live (pulse → green), threshold fill bar, Sui tx links.
 */

import { useMemo } from "react";
import { useDagStore } from "../../state/dagStore.js";
import { useUiStore } from "../../state/uiStore.js";
import { branchTone } from "../../ui/branch.js";
import type {
  MergeProposal,
  AttestationRecord,
  JuryJudge,
  MemoryBranch,
} from "../../sui/types.js";
import "./MergesView.css";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function countdown(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "expired";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── Attestation row ──────────────────────────────────────────────────────────

function AttestRow({ attest }: { attest: AttestationRecord }) {
  const label   = attest.label ?? attest.signer.slice(0, 10) + "…";
  const tooltip = [
    attest.sig_verified !== false && "Ed25519 sig verified on-chain",
    attest.tx_digest && `tx ${attest.tx_digest.slice(0, 16)}…`,
  ].filter(Boolean).join("\n");

  return (
    <li className="ceremony-attest-row ceremony-attest-row--cast" title={tooltip}>
      <span className="ceremony-attest-check" aria-label="attested">✓</span>
      <span className="ceremony-attest-label">{label}</span>
      {attest.model && <span className="ceremony-attest-model">{attest.model}</span>}
      {attest.vote && (
        <span className="ceremony-attest-vote-text">voted {attest.vote}</span>
      )}
      <span className="ceremony-attest-time-spacer" />
      <span className="ceremony-attest-reltime">{relTime(attest.ts_ms)}</span>
    </li>
  );
}

function PendingJudgeRow({ judge }: { judge: JuryJudge }) {
  return (
    <li className="ceremony-attest-row ceremony-attest-row--pending">
      <span className="ceremony-attest-pulse" aria-label="waiting" />
      <span className="ceremony-attest-label">{judge.label}</span>
      <span className="ceremony-attest-model">{judge.model}</span>
      <span className="ceremony-attest-voting">voting…</span>
    </li>
  );
}

// ─── Threshold bar ────────────────────────────────────────────────────────────

function ThresholdBar({
  attestCount,
  threshold,
  total,
}: {
  attestCount: number;
  threshold:   number;
  total:       number;
}) {
  const pct = Math.min(attestCount / threshold, 1) * 100;
  return (
    <div className="ceremony-threshold">
      <div className="ceremony-threshold-bar">
        <div
          className="ceremony-threshold-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="ceremony-threshold-label">
        {attestCount} of {threshold} required
        {total > threshold && ` (${total} judges)`}
        <span className="ceremony-threshold-note"> · enforced by Move ◈</span>
      </span>
    </div>
  );
}

// ─── Active ceremony card ─────────────────────────────────────────────────────

function CeremonyCard({ proposal }: { proposal: MergeProposal }) {
  const judges    = proposal.jury_judges ?? [];
  const threshold = proposal.jury_threshold ?? judges.length;
  const attested  = proposal.attestations;

  // Determine which judges have voted and which are still pending
  const attestedAddrs = new Set(attested.map((a) => a.signer));
  const pendingJudges = judges.filter((j) => !attestedAddrs.has(j.address));

  const expiresIn   = countdown(proposal.expires_at_ms ?? 0);
  const isExpiring  = (proposal.expires_at_ms ?? 0) - Date.now() < 30 * 60 * 1000;

  return (
    <div className="ceremony-card">
      {/* Card header */}
      <div className="ceremony-header">
        <div className="ceremony-header-left">
          <span className="ceremony-icon" aria-hidden>⚖</span>
          <span className="ceremony-route-text">
            <strong>{proposal.from_branch}</strong>
            <span className="ceremony-arrow">→</span>
            <strong>{proposal.into_branch}</strong>
          </span>
          {proposal.resolver_label && (
            <span className="ceremony-resolver-label">{proposal.resolver_label}</span>
          )}
        </div>
        <div className="ceremony-header-right">
          <span className={`ceremony-expiry${isExpiring ? " ceremony-expiry--warn" : ""}`}>
            expires in {expiresIn}
          </span>
        </div>
      </div>

      {/* Attestation rows */}
      <ul className="ceremony-attests" aria-label="Attestations">
        {attested.map((a, i) => (
          <AttestRow key={i} attest={a} />
        ))}
        {pendingJudges.map((j) => (
          <PendingJudgeRow key={j.address} judge={j} />
        ))}
        {/* If no judge config, just show arrived attestations */}
        {judges.length === 0 && attested.length === 0 && (
          <li className="ceremony-attests-empty">Waiting for jury workers…</li>
        )}
      </ul>

      {/* Threshold bar */}
      <ThresholdBar
        attestCount={attested.length}
        threshold={threshold}
        total={judges.length || threshold}
      />
    </div>
  );
}

// ─── Settled row ──────────────────────────────────────────────────────────────

function SettledRow({ proposal }: { proposal: MergeProposal }) {
  const openProposal = useUiStore((s) => s.openProposal);
  const attestCount  = proposal.attestations.length;

  return (
    <li
      role="button"
      tabIndex={0}
      className="settled-row"
      onClick={() => openProposal(proposal)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && openProposal(proposal)}
    >
      <div className="settled-row-left">
        <span className="settled-check" aria-label="finalized">✓</span>
        <span className="settled-route">
          <strong>{proposal.from_branch}</strong>
          <span className="settled-arrow" aria-hidden>→</span>
          <strong>{proposal.into_branch}</strong>
        </span>
        {proposal.resolver_label && (
          <span className="settled-resolver">{proposal.resolver_label}</span>
        )}
        {attestCount > 0 && (
          <span className="settled-resolver">{attestCount} attest.</span>
        )}
      </div>
      <div className="settled-row-right">
        <span className="settled-time">{relTime(proposal.ts_ms)}</span>
        <span className="settled-view-hint">view →</span>
      </div>
    </li>
  );
}

// ─── Graveyard row ────────────────────────────────────────────────────────────

function GraveyardRow({ branch }: { branch: MemoryBranch }) {
  const setActiveBranch = useUiStore((s) => s.setActiveBranch);
  const setActiveView   = useUiStore((s) => s.setActiveView);

  function handleAsk() {
    setActiveBranch(branch.name);
    setActiveView("history");
  }

  return (
    <li className="graveyard-row">
      <div className="graveyard-row-top">
        <span className="graveyard-cross" aria-hidden>✗</span>
        <span className={`chip ${branchTone(branch.name)}`}>{branch.name}</span>
        <span className="graveyard-time">rejected {relTime(branch.ts_ms)}</span>
        <button className="graveyard-ask-btn" onClick={handleAsk} title="Browse this branch">
          ask it
        </button>
      </div>
      {branch.rejection_rationale && (
        <p className="graveyard-rationale">{branch.rejection_rationale}</p>
      )}
    </li>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

export default function MergesView() {
  const proposals       = useDagStore((s) => s.proposals);
  const orderedBranches = useDagStore((s) => s.orderedBranches);

  const { pending, settled, graveyard } = useMemo(() => {
    const all = Array.from(proposals.values()).sort((a, b) => b.ts_ms - a.ts_ms);
    return {
      pending:   all.filter((p) => p.status === "pending"),
      settled:   all.filter((p) => p.status === "finalized" || p.status === "aborted"),
      graveyard: orderedBranches.filter((b) => b.is_graveyard),
    };
  }, [proposals, orderedBranches]);

  const isEmpty = pending.length === 0 && settled.length === 0 && graveyard.length === 0;

  if (isEmpty) {
    return (
      <div className="merges-empty">
        <p>No merge proposals yet.</p>
        <p className="merges-empty-sub">
          Proposals appear when <code>memfork merge</code> is run or{" "}
          <code>mem.proposeMerge()</code> is called from the SDK.
        </p>
      </div>
    );
  }

  return (
    <div className="merges-view">
      {/* ── Active ceremonies ── */}
      {pending.length > 0 && (
        <section className="merges-section">
          <header className="merges-section-header">
            <span className="merges-section-title">Active</span>
            <span className="chip orange">{pending.length}</span>
          </header>
          <div className="merges-ceremonies">
            {pending.map((p) => (
              <CeremonyCard key={p.id} proposal={p} />
            ))}
          </div>
        </section>
      )}

      {/* ── Settled history ── */}
      {settled.length > 0 && (
        <section className="merges-section">
          <header className="merges-section-header">
            <span className="merges-section-title">Settled</span>
            <span className="chip muted">{settled.length}</span>
          </header>
          <ul className="merges-settled-list">
            {settled.map((p) => (
              <SettledRow key={p.id} proposal={p} />
            ))}
          </ul>
        </section>
      )}

      {/* ── Graveyard ── */}
      {graveyard.length > 0 && (
        <section className="merges-section merges-section--graveyard">
          <header className="merges-section-header">
            <span className="merges-section-title">Roads not taken</span>
            <span className="chip muted">{graveyard.length}</span>
          </header>
          <p className="merges-graveyard-note">
            These branches lost a merge vote. Their memory is still intact and queryable —
            they didn't disappear, they just didn't win.
          </p>
          <ul className="merges-graveyard-list">
            {graveyard.map((b) => (
              <GraveyardRow key={b.name} branch={b} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
