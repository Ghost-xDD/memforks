import { useEffect, useRef } from "react";
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

export default function App() {
  const activeView       = useUiStore((s) => s.activeView);
  const activeBranch     = useUiStore((s) => s.activeBranch);
  const setLive              = useDagStore((s) => s.setLive);
  const setTreeId            = useDagStore((s) => s.setTreeId);
  const applyBranch          = useDagStore((s) => s.applyBranch);
  const applyProposal        = useDagStore((s) => s.applyProposal);
  const applyAttestation     = useDagStore((s) => s.applyAttestation);
  const applyFinalized       = useDagStore((s) => s.applyFinalized);
  const applyAborted         = useDagStore((s) => s.applyAborted);
  const applyOffChainCommits = useDagStore((s) => s.applyOffChainCommits);
  const setFacts             = useMemoryStore((s) => s.setFacts);

  const bootstrapped = useRef(false);
  const hasMemwalRef = useRef(false);

  // ── Initial bootstrap ──────────────────────────────────────────────────────
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    (async () => {
      // Resolve runtime config from local server → URL params → defaults.
      const cfg = await memForksClient.loadConfig();

      // Tell the store about the resolved tree ID so TopBar can show it.
      setTreeId(cfg.treeId);
      hasMemwalRef.current = cfg.hasMemwal;

      // ?demo=1 forces seeded demo data regardless of live availability.
      const params    = new URLSearchParams(window.location.search);
      const forceDemo = params.get("demo") !== null;

      // If no live server answered and no URL param, fall back to demo.
      const hasLiveSource =
        !forceDemo &&
        (cfg.hasMemwal ||
          !!params.get("tree") ||
          document.URL.includes("localhost"));

      if (!hasLiveSource) {
        seedDemoData();
        return;
      }

      // Live mode — subscribe to Sui events.
      memForksClient.setHandlers({
        onBranch:      applyBranch,
        onProposed:    applyProposal,
        onAttestation: applyAttestation,
        onFinalized:   applyFinalized,
        onAborted:     applyAborted,
      });

      try {
        await memForksClient.fetchHistory();
        setLive(true);
        memForksClient.startPolling(5_000);

        // Hydrate every known branch (not just main) so the "All branches"
        // view and the Memory tab are populated immediately.
        if (cfg.hasMemwal) {
          await loadAllBranches(applyOffChainCommits, setFacts);
        }
      } catch (err) {
        console.warn("[memforks] live fetch failed, falling back to demo:", err);
        seedDemoData();
      }
    })();

    // The MemWal relayer caps usage at 500 weighted-requests/hour, so we can't
    // poll every branch on a tight loop. Instead:
    //   • refresh only the *active* branch (the one being viewed) every 30 s, and
    //   • do a full all-branch sweep every 4 min to catch background activity.
    // New commits on the branch you're looking at still appear within 30 s; a
    // freshly created branch is loaded immediately on selection (effect below).
    const activeTimer = setInterval(() => {
      if (!hasMemwalRef.current) return;
      const branch = useUiStore.getState().activeBranch ?? "main";
      loadBranch(branch, applyOffChainCommits, setFacts);
    }, 30_000);

    const sweepTimer = setInterval(() => {
      if (!hasMemwalRef.current) return;
      loadAllBranches(applyOffChainCommits, setFacts);
    }, 240_000);

    return () => {
      memForksClient.stopPolling();
      clearInterval(activeTimer);
      clearInterval(sweepTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Snappy refresh of the selected branch on switch ────────────────────────
  useEffect(() => {
    if (!hasMemwalRef.current || !activeBranch) return;
    loadBranch(activeBranch, applyOffChainCommits, setFacts);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBranch]);

  return (
    <div className="app-root">
      <TopBar />
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

// ─── Live data loading ─────────────────────────────────────────────────────────

import type { OffChainCommit } from "./sui/types.js";
import type { MemoryFact } from "./state/memoryStore.js";

type SetFacts     = (branch: string, facts: MemoryFact[]) => void;
type ApplyCommits = (commits: OffChainCommit[]) => void;

/** djb2 hash → base36. Stable across reloads; collision-resistant enough for keys. */
function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Heuristic topic classifier — turns a free-text fact into one of a small set
 * of human-readable categories used for grouping in the Memory view. Order
 * matters: earlier rules win, so the more specific topics come first.
 */
const CATEGORY_RULES: { name: string; re: RegExp }[] = [
  { name: "Setup & Provisioning",  re: /\b(provision|quickstart|install|setup|onboard|deploy|mainnet|testnet|gas|sponsor|bootstrap)\b/i },
  { name: "Error Handling",        re: /\b(error|exception|throw|catch|fail|apperror|retry|fallback|crash)\b/i },
  { name: "Security & Auth",       re: /\b(auth|permission|credential|secret|encrypt|decrypt|seal|signature|token|access|delegate|private key)\b/i },
  { name: "Testing & QA",          re: /\b(test|spec|coverage|assert|mock|fixture|e2e|lint|ci\b)/i },
  { name: "Memory & Versioning",   re: /\b(branch|merge|resolver|namespace|commit|fork|recall|anchor|walrus|on-chain)\b/i },
  { name: "Architecture & Design", re: /\b(architect|design|pattern|module|structure|schema|interface|component|service|endpoint|\bapi\b)\b/i },
  { name: "Conventions & Style",   re: /\b(convention|standard|always|never|prefer|style|format|naming|guideline|\brule\b)\b/i },
  { name: "Performance",           re: /\b(performance|latency|cache|optimi[sz]|throughput|speed|slow|fast)\b/i },
];

function categorize(text: string): string {
  for (const rule of CATEGORY_RULES) if (rule.re.test(text)) return rule.name;
  return "General";
}

/** The set of branches to hydrate: every branch in the DAG store plus main. */
function knownBranches(): string[] {
  const set = new Set<string>(["main"]);
  for (const name of useDagStore.getState().branches.keys()) set.add(name);
  return Array.from(set);
}

/**
 * Fetch one branch's off-chain history and derive memory facts from the same
 * payload — a single round-trip keeps commits and facts perfectly in sync.
 */
async function loadBranch(
  branch: string,
  applyCommits: ApplyCommits,
  setFacts: SetFacts,
): Promise<void> {
  try {
    const r = await fetch(`/api/history?branch=${encodeURIComponent(branch)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return;
    const data = await r.json() as { commits: OffChainCommit[] };
    const commits = data.commits ?? [];
    if (commits.length) applyCommits(commits);

    // Derive memory facts from the commit deltas (dedup identical facts).
    const seen = new Set<string>();
    const facts: MemoryFact[] = [];
    for (const c of commits) {
      const delta = (c.delta ?? {}) as Record<string, unknown>;
      const factStrings = (delta["facts"] as string[] | undefined) ?? [];
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
    // Always set (even empty) so a branch that lost all facts clears correctly.
    setFacts(branch, facts);
  } catch (e) {
    console.warn(`[memforks] load failed for ${branch}:`, e);
  }
}

/** Hydrate every known branch in parallel. */
async function loadAllBranches(
  applyCommits: ApplyCommits,
  setFacts: SetFacts,
): Promise<void> {
  await Promise.allSettled(
    knownBranches().map((b) => loadBranch(b, applyCommits, setFacts)),
  );
}
