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
  const setLive          = useDagStore((s) => s.setLive);
  const setTreeId        = useDagStore((s) => s.setTreeId);
  const applyBranch      = useDagStore((s) => s.applyBranch);
  const applyProposal    = useDagStore((s) => s.applyProposal);
  const applyAttestation = useDagStore((s) => s.applyAttestation);
  const applyFinalized   = useDagStore((s) => s.applyFinalized);
  const applyAborted     = useDagStore((s) => s.applyAborted);
  const setFacts         = useMemoryStore((s) => s.setFacts);

  const bootstrapped = useRef(false);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    (async () => {
      // Resolve runtime config from local server → URL params → defaults.
      const cfg = await memForksClient.loadConfig();

      // Tell the store about the resolved tree ID so TopBar can show it.
      setTreeId(cfg.treeId);

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

        // Hydrate Memory view from the local server's MemWal proxy.
        if (cfg.hasMemwal) {
          loadFacts("main", setFacts);
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

type SetFacts = (branch: string, facts: import("./state/memoryStore.js").MemoryFact[]) => void;

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
