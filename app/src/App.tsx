import { useEffect, useRef } from "react";
import TopBar        from "./layout/TopBar.js";
import RightDrawer   from "./layout/RightDrawer.js";
import DagCanvas     from "./views/dag/DagCanvas.js";
import MemoryView    from "./views/memory/MemoryView.js";
import HistoryView   from "./views/history/HistoryView.js";
import { useDagStore } from "./state/dagStore.js";
import { useUiStore } from "./state/uiStore.js";
import { memForksClient } from "./sui/client.js";
import { seedDemoData } from "./seed/demo.js";
import "./styles/global.css";
import "./App.css";

const USE_DEMO = import.meta.env.VITE_DEMO_MODE !== "false";

export default function App() {
  const activeView    = useUiStore((s) => s.activeView);
  const setLive       = useDagStore((s) => s.setLive);
  const applyCommit   = useDagStore((s) => s.applyCommit);
  const applyBranch   = useDagStore((s) => s.applyBranch);
  const applyProposal = useDagStore((s) => s.applyProposal);
  const applyAttestation = useDagStore((s) => s.applyAttestation);
  const applyFinalized   = useDagStore((s) => s.applyFinalized);
  const applyAborted     = useDagStore((s) => s.applyAborted);

  const bootstrapped = useRef(false);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    if (USE_DEMO) {
      seedDemoData();
      return;
    }

    // Live mode — subscribe to Sui events.
    memForksClient.setHandlers({
      onCommit:      applyCommit,
      onBranch:      applyBranch,
      onProposed:    applyProposal,
      onAttestation: applyAttestation,
      onFinalized:   applyFinalized,
      onAborted:     applyAborted,
    });

    memForksClient
      .fetchHistory()
      .then(() => {
        setLive(true);
        memForksClient.startPolling(5_000);
      })
      .catch((err) => {
        console.warn("[memforks] live fetch failed, falling back to demo:", err);
        seedDemoData();
      });

    return () => {
      memForksClient.stopPolling();
    };
  }, [applyCommit, applyBranch, applyProposal, applyAttestation, applyFinalized, applyAborted, setLive]);

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
