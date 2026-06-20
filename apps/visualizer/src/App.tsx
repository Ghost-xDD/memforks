import { useEffect, useRef, useCallback } from "react";
import TopBar        from "./layout/TopBar.js";
import RightDrawer   from "./layout/RightDrawer.js";
import DagCanvas     from "./views/dag/DagCanvas.js";
import MemoryView    from "./views/memory/MemoryView.js";
import HistoryView   from "./views/history/HistoryView.js";
import MergesView    from "./views/merges/MergesView.js";
import { useDagStore } from "./state/dagStore.js";
import { useUiStore } from "./state/uiStore.js";
import { useMemoryStore } from "./state/memoryStore.js";
import { memForksClient } from "./sui/client.js";
import { seedDemoData } from "./seed/demo.js";
import "./styles/global.css";
import "./App.css";

// ─── Rate-limit banner ────────────────────────────────────────────────────────

function RateLimitBanner({ secondsLeft }: { secondsLeft: number }) {
  if (secondsLeft <= 0) return null;
  const mins = Math.ceil(secondsLeft / 60);
  return (
    <div style={{
      background: "var(--surface-1)",
      borderBottom: "1px solid var(--border)",
      color: "var(--fg-2)",
      fontSize: "0.75rem",
      padding: "6px 16px",
      display: "flex",
      alignItems: "center",
      gap: 8,
    }}>
      <span style={{ color: "var(--yellow, #e8a600)" }}>⚠</span>
      MemWal rate limit active — showing cached data.
      Auto-retry in {secondsLeft < 60 ? `${secondsLeft}s` : `~${mins}m`}.
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const activeView       = useUiStore((s) => s.activeView);
  const activeBranch     = useUiStore((s) => s.activeBranch);
  const setLive              = useDagStore((s) => s.setLive);
  const setTreeId            = useDagStore((s) => s.setTreeId);
  const applyBranch          = useDagStore((s) => s.applyBranch);
  const applyProposal        = useDagStore((s) => s.applyProposal);
  const enrichProposal       = useDagStore((s) => s.enrichProposal);
  const applyAttestation     = useDagStore((s) => s.applyAttestation);
  const applyFinalized       = useDagStore((s) => s.applyFinalized);
  const applyAborted         = useDagStore((s) => s.applyAborted);
  const applyOffChainCommits = useDagStore((s) => s.applyOffChainCommits);
  const setFacts             = useMemoryStore((s) => s.setFacts);

  const bootstrapped  = useRef(false);
  const hasMemwalRef  = useRef(false);
  const retryInSecs   = useUiStore((s) => s.retryInSeconds ?? 0);
  const setRateLimit  = useUiStore((s) => s.setRateLimit);

  // ── Refresh callback — force-reload all known branches; exposed to TopBar ──
  const refreshAll = useCallback(async () => {
    if (!hasMemwalRef.current) return;
    await loadAllBranches(applyOffChainCommits, setFacts, setRateLimit, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Expose refreshAll to TopBar via a stable ref on the store.
  useUiStore.getState().setRefreshAll(refreshAll);

  // ── Initial bootstrap ──────────────────────────────────────────────────────
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    (async () => {
      const cfg = await memForksClient.loadConfig();
      setTreeId(cfg.treeId);
      hasMemwalRef.current = cfg.hasMemwal;

      const params    = new URLSearchParams(window.location.search);
      const forceDemo = params.get("demo") !== null;
      const hasLiveSource =
        !forceDemo &&
        (cfg.hasMemwal || !!params.get("tree") || document.URL.includes("localhost"));

      if (!hasLiveSource) { seedDemoData(); return; }

      memForksClient.setHandlers({
        onBranch:   applyBranch,
        onProposed: (e) => {
          applyProposal(e);
          enrichFromResolver(e.proposal_id, e.resolver_id, enrichProposal);
        },
        onAttestation: applyAttestation,
        onFinalized:   applyFinalized,
        onAborted:     applyAborted,
      });

      try {
        await memForksClient.fetchHistory();
        setLive(true);
        memForksClient.startPolling(5_000);

        // Load only the active/default branch on startup — not a full sweep.
        // The Refresh button in TopBar does the full cross-branch load on demand.
        if (cfg.hasMemwal) {
          const branch = useUiStore.getState().activeBranch ?? "main";
          await loadBranch(branch, applyOffChainCommits, setFacts, setRateLimit, false);
        }
      } catch (err) {
        console.warn("[memforks] live fetch failed, falling back to demo:", err);
        seedDemoData();
      }
    })();

    // Poll the active branch every 60 s. On-chain events (forks, merges) still
    // update at 5 s via memForksClient.startPolling above — this covers only
    // off-chain MemWal commits and memory facts.
    const pollTimer = setInterval(() => {
      if (!hasMemwalRef.current) return;
      const branch = useUiStore.getState().activeBranch ?? "main";
      loadBranch(branch, applyOffChainCommits, setFacts, setRateLimit, false);
    }, 60_000);

    // Count down the rate-limit display every second.
    const countdownTimer = setInterval(() => {
      const s = useUiStore.getState().retryInSeconds ?? 0;
      if (s > 0) useUiStore.getState().setRateLimit(true, s - 1);
      else if (useUiStore.getState().rateLimited) useUiStore.getState().setRateLimit(false, 0);
    }, 1_000);

    return () => {
      memForksClient.stopPolling();
      clearInterval(pollTimer);
      clearInterval(countdownTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Immediate refresh on branch switch ────────────────────────────────────
  useEffect(() => {
    if (!hasMemwalRef.current || !activeBranch) return;
    loadBranch(activeBranch, applyOffChainCommits, setFacts, setRateLimit, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBranch]);

  return (
    <div className="app-root">
      <TopBar />
      <RateLimitBanner secondsLeft={retryInSecs} />
      <div className="app-body">
        {activeView === "memory"  && <MemoryView />}
        {activeView === "history" && <HistoryView />}
        {activeView === "merges"  && <MergesView />}
        {activeView === "graph"   && <DagCanvas />}
        <RightDrawer />
      </div>
    </div>
  );
}

// ─── Resolver enrichment ──────────────────────────────────────────────────────

const resolverKindCache = new Map<string, number>();

function resolverKindToLabel(kind: number): string {
  if (kind === 0x00) return "LWW";
  if (kind === 0x01) return "Union";
  return `Kind(${kind})`;
}

import type { MergeProposal } from "./sui/types.js";
type EnrichProposalFn = (id: string, patch: Partial<Pick<MergeProposal, "resolver_label" | "jury_threshold" | "jury_judges">>) => void;

async function enrichFromResolver(
  proposalId: string,
  resolverId: string,
  enrich: EnrichProposalFn,
): Promise<void> {
  if (resolverKindCache.has(resolverId)) {
    enrich(proposalId, { resolver_label: resolverKindToLabel(resolverKindCache.get(resolverId)!) });
    return;
  }
  const kind = await memForksClient.fetchResolverKind(resolverId);
  if (kind !== null) {
    resolverKindCache.set(resolverId, kind);
    enrich(proposalId, { resolver_label: resolverKindToLabel(kind) });
  }
}

// ─── Live data loading ─────────────────────────────────────────────────────────

import type { OffChainCommit } from "./sui/types.js";
import type { MemoryFact } from "./state/memoryStore.js";

type SetFacts     = (branch: string, facts: MemoryFact[]) => void;
type ApplyCommits = (commits: OffChainCommit[]) => void;
type SetRateLimit = (limited: boolean, retryInSeconds: number) => void;

function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const CATEGORY_RULES: { name: string; re: RegExp }[] = [
  { name: "Setup & Provisioning",  re: /\b(provision|quickstart|install|setup|onboard|deploy|mainnet|testnet|gas|sponsor|bootstrap)\b/i },
  { name: "Error Handling",        re: /\b(error|exception|throw|catch|fail|apperror|retry|fallback|crash)\b/i },
  { name: "Security & Auth",       re: /\b(auth|permission|credential|secret|encrypt|decrypt|seal|signature|token|access|delegate|private key)\b/i },
  { name: "Testing & QA",          re: /\b(test|spec|coverage|assert|mock|fixture|e2e|lint|ci)\b/i },
  { name: "Memory & Versioning",   re: /\b(branch|merge|resolver|namespace|commit|fork|recall|anchor|walrus|on-chain)\b/i },
  { name: "Architecture & Design", re: /\b(architect|design|pattern|module|structure|schema|interface|component|service|endpoint|\bapi\b)\b/i },
  { name: "Conventions & Style",   re: /\b(convention|standard|always|never|prefer|style|format|naming|guideline|\brule\b)\b/i },
  { name: "Performance",           re: /\b(performance|latency|cache|optimi[sz]|throughput|speed|slow|fast)\b/i },
];

function categorize(text: string): string {
  for (const rule of CATEGORY_RULES) if (rule.re.test(text)) return rule.name;
  return "General";
}

function knownBranches(): string[] {
  const set = new Set<string>(["main"]);
  for (const name of useDagStore.getState().branches.keys()) set.add(name);
  return Array.from(set);
}

async function loadBranch(
  branch: string,
  applyCommits: ApplyCommits,
  setFacts: SetFacts,
  setRateLimit: SetRateLimit,
  force: boolean,
): Promise<void> {
  try {
    const qs = `branch=${encodeURIComponent(branch)}${force ? "&force=1" : ""}`;
    const r  = await fetch(`/api/history?${qs}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return;
    const data = await r.json() as {
      commits: OffChainCommit[];
      rateLimited?: boolean;
      retryInSeconds?: number;
    };

    // Propagate rate-limit state to the banner.
    if (data.rateLimited) {
      setRateLimit(true, data.retryInSeconds ?? 0);
    } else {
      setRateLimit(false, 0);
    }

    const commits = data.commits ?? [];
    if (commits.length) applyCommits(commits);

    // Derive facts from commits — no separate /api/facts call needed.
    const seen = new Set<string>();
    const facts: MemoryFact[] = [];
    for (const c of commits) {
      const factStrings = ((c.delta as Record<string, unknown>)?.["facts"] as string[] | undefined) ?? [];
      for (const text of factStrings) {
        const norm = text.trim();
        if (!norm) continue;
        const key = hashText(norm.toLowerCase());
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({
          key,
          content:          norm,
          category:         categorize(norm),
          introduced_by:    c.blob_id.slice(0, 7),
          introduced_by_id: c.blob_id,
          branch,
          ts_ms:            c.ts_ms,
        });
      }
    }
    setFacts(branch, facts);
  } catch (e) {
    console.warn(`[memforks] load failed for ${branch}:`, e);
  }
}

async function loadAllBranches(
  applyCommits: ApplyCommits,
  setFacts: SetFacts,
  setRateLimit: SetRateLimit,
  force: boolean,
): Promise<void> {
  await Promise.allSettled(
    knownBranches().map((b) => loadBranch(b, applyCommits, setFacts, setRateLimit, force)),
  );
}
