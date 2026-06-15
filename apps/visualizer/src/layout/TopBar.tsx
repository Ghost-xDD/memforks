import { useEffect, useRef } from "react";
import { useDagStore } from "../state/dagStore.js";
import { useUiStore } from "../state/uiStore.js";
import type { ActiveView } from "../state/uiStore.js";
import "./TopBar.css";

const VIEWS: { id: ActiveView; label: string }[] = [
  { id: "memory",  label: "Memory"  },
  { id: "history", label: "History" },
  { id: "merges",  label: "Merges"  },
  { id: "graph",   label: "Map"     },
];

export default function TopBar() {
  const branches       = useDagStore((s) => s.branches);
  const orderedAnchors = useDagStore((s) => s.orderedAnchors);
  const proposals      = useDagStore((s) => s.proposals);
  const isLive         = useDagStore((s) => s.isLive);
  const treeId         = useDagStore((s) => s.treeId);

  const activeBranch    = useUiStore((s) => s.activeBranch);
  const setActiveBranch = useUiStore((s) => s.setActiveBranch);
  const activeView      = useUiStore((s) => s.activeView);
  const setActiveView   = useUiStore((s) => s.setActiveView);
  const replayActive    = useUiStore((s) => s.replayActive);
  const replayIndex     = useUiStore((s) => s.replayIndex);
  const startReplay     = useUiStore((s) => s.startReplay);
  const stepReplay      = useUiStore((s) => s.stepReplay);
  const stopReplay      = useUiStore((s) => s.stopReplay);

  const replayTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Drive the replay interval from this component.
  useEffect(() => {
    if (!replayActive) {
      if (replayTimer.current) {
        clearInterval(replayTimer.current);
        replayTimer.current = null;
      }
      return;
    }

    replayTimer.current = setInterval(() => {
      const total = useDagStore.getState().orderedAnchors.length;
      const idx   = useUiStore.getState().replayIndex;
      if (idx >= total) {
        stopReplay();
      } else {
        stepReplay();
      }
    }, 600);

    return () => {
      if (replayTimer.current) clearInterval(replayTimer.current);
    };
  }, [replayActive, stepReplay, stopReplay]);

  const handleReplay = () => {
    if (replayActive) {
      stopReplay();
    } else {
      startReplay();
      // Switch to graph view so the user sees nodes appearing.
      setActiveView("graph");
    }
  };

  const branchNames = Array.from(branches.keys()).sort((a, b) => {
    if (a === "main") return -1;
    if (b === "main") return 1;
    return a.localeCompare(b);
  });

  const pendingCount = Array.from(proposals.values()).filter(
    (p) => p.status === "pending",
  ).length;

  const shortTree = treeId
    ? treeId.slice(0, 6) + "…" + treeId.slice(-4)
    : "no tree";

  const replayLabel = replayActive
    ? `■ ${replayIndex}/${orderedAnchors.length}`
    : "▶ Replay";

  return (
    <header className="topbar">
      {/* Left — tree identity */}
      <div className="topbar-left">
        <span className="topbar-logo">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="12" cy="12" r="3" />
            <circle cx="12" cy="4"  r="2" />
            <circle cx="20" cy="16" r="2" />
            <circle cx="4"  cy="16" r="2" />
            <line x1="12" y1="6"  x2="12" y2="9"  />
            <line x1="18.5" y1="14.5" x2="14.5" y2="12.5" />
            <line x1="5.5"  y1="14.5" x2="9.5"  y2="12.5" />
          </svg>
          MemForks
        </span>

        <code className="topbar-tree-id" title={treeId ?? ""}>
          {shortTree}
        </code>

        <span className={`topbar-live-badge ${isLive ? "live" : "offline"}`}>
          <span className="topbar-live-dot" />
          {isLive ? "Live" : "Demo"}
        </span>
      </div>

      {/* Centre-left — view tabs */}
      <nav className="topbar-views" aria-label="View switcher">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className={`topbar-view-btn ${activeView === v.id ? "active" : ""}`}
            onClick={() => setActiveView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </nav>

      {/* Flexible gap */}
      <div className="topbar-spacer" />

      {/* Right — branch picker, proposals, replay */}
      <div className="topbar-right">
        <select
          className="topbar-branch-select"
          value={activeBranch ?? ""}
          onChange={(e) => setActiveBranch(e.target.value || null)}
          aria-label="Branch filter"
        >
          <option value="">All branches</option>
          {branchNames.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        {pendingCount > 0 && (
          <button
            className="chip orange"
            style={{ cursor: "pointer" }}
            onClick={() => setActiveView("merges")}
            title="View open proposals"
          >
            ⚖ {pendingCount}
          </button>
        )}
        {orderedAnchors.length > 0 && (
          <button
            className={`topbar-replay-btn ${replayActive ? "active" : ""}`}
            onClick={handleReplay}
            title={replayActive ? "Stop replay" : "Replay merge history"}
          >
            {replayLabel}
          </button>
        )}
      </div>
    </header>
  );
}
