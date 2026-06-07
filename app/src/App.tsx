import { useEffect, useRef } from "react";
import TopBar        from "./layout/TopBar.js";
import RightDrawer   from "./layout/RightDrawer.js";
import DagCanvas     from "./views/dag/DagCanvas.js";
import MemoryView    from "./views/memory/MemoryView.js";
import HistoryView   from "./views/history/HistoryView.js";
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

      // If no live server answered and no URL param, fall back to demo.
      const hasLiveSource =
        cfg.hasMemwal ||
        !!new URLSearchParams(window.location.search).get("tree") ||
        document.URL.includes("localhost");

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

        // Initial hydration for the default branch.
        if (cfg.hasMemwal) {
          loadFacts("main", setFacts);
          loadHistory("main", applyOffChainCommits);
        }
      } catch (err) {
        console.warn("[memforks] live fetch failed, falling back to demo:", err);
        seedDemoData();
      }
    })();

    return () => {
      memForksClient.stopPolling();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Reload facts + history when the user switches branches ─────────────────
  useEffect(() => {
    if (!hasMemwalRef.current) return;
    const branch = activeBranch ?? "main";
    loadFacts(branch, setFacts);
    loadHistory(branch, applyOffChainCommits);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBranch]);

  return (
    <div className="app-root">
      <TopBar />
      <div className="app-body">
        {activeView === "memory"  && <MemoryView />}
        {activeView === "history" && <HistoryView />}
        {activeView === "graph"   && <DagCanvas />}
        <RightDrawer />
      </div>
    </div>
  );
}

// ─── Live MemWal recall ───────────────────────────────────────────────────────

import type { OffChainCommit } from "./sui/types.js";

type SetFacts = (branch: string, facts: import("./state/memoryStore.js").MemoryFact[]) => void;
type ApplyCommits = (commits: OffChainCommit[]) => void;

async function loadHistory(branch: string, apply: ApplyCommits): Promise<void> {
  try {
    const r = await fetch(`/api/history?branch=${encodeURIComponent(branch)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return;
    const data = await r.json() as { commits: OffChainCommit[] };
    if (data.commits?.length) apply(data.commits);
  } catch (e) {
    console.warn("[memforks] history fetch failed:", e);
  }
}

async function loadFacts(branch: string, setFacts: SetFacts): Promise<void> {
  try {
    const r = await fetch(`/api/facts?branch=${encodeURIComponent(branch)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return;

    const data = await r.json() as { facts: Array<Record<string, unknown>> };
    const facts = (data.facts ?? []).map((entry, i) => ({
      key:              String(entry["path"] ?? entry["key"] ?? `fact.${i}`),
      content:          String(entry["text"] ?? entry["content"] ?? ""),
      introduced_by:    String(entry["blob_id"] ?? "").slice(0, 7),
      introduced_by_id: String(entry["blob_id"] ?? ""),
      branch,
      ts_ms:            Number(entry["created_at"] ?? Date.now()),
    }));

    if (facts.length > 0) {
      setFacts(branch, facts);
    }
  } catch (e) {
    console.warn("[memforks] MemWal facts fetch failed:", e);
  }
}
