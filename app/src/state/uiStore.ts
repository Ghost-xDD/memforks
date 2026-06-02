/**
 * UI state — selected nodes, active drawer panel, branch filter, replay mode.
 */

import { create } from "zustand";
import type { MemoryCommit, MergeProposal } from "../sui/types.js";

export type ActiveView = "memory" | "history" | "graph";

export type DrawerPanel =
  | { kind: "commit";   commit:   MemoryCommit   }
  | { kind: "proposal"; proposal: MergeProposal  }
  | null;

interface UiState {
  // Active view
  activeView:     ActiveView;
  setActiveView:  (v: ActiveView) => void;

  // Drawer
  panel:          DrawerPanel;
  openCommit:     (c: MemoryCommit)   => void;
  openProposal:   (p: MergeProposal)  => void;
  closeDrawer:    ()                  => void;

  // Branch filter (null = show all)
  activeBranch:   string | null;
  setActiveBranch:(name: string | null) => void;

  // Highlighted commit (hover)
  hoveredId:      string | null;
  setHovered:     (id: string | null) => void;

  // Replay mode
  replayActive:   boolean;
  replayIndex:    number;
  startReplay:    ()  => void;
  stepReplay:     ()  => void;
  stopReplay:     ()  => void;

  // Zoom-to-commit callback (set by DagCanvas)
  zoomToCommit:   ((id: string) => void) | null;
  registerZoom:   (fn: (id: string) => void) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  activeView:   "memory",
  panel:        null,
  activeBranch: null,
  hoveredId:    null,
  replayActive: false,
  replayIndex:  0,
  zoomToCommit: null,

  setActiveView(v) { set({ activeView: v }); },

  openCommit(c) {
    set({ panel: { kind: "commit", commit: c } });
    get().zoomToCommit?.(c.id);
  },

  openProposal(p) {
    set({ panel: { kind: "proposal", proposal: p } });
  },

  closeDrawer() { set({ panel: null }); },

  setActiveBranch(name) { set({ activeBranch: name }); },

  setHovered(id) { set({ hoveredId: id }); },

  startReplay() { set({ replayActive: true, replayIndex: 0 }); },
  stepReplay()  { set((s) => ({ replayIndex: s.replayIndex + 1 })); },
  stopReplay()  { set({ replayActive: false, replayIndex: 0 }); },

  registerZoom(fn) { set({ zoomToCommit: fn }); },
}));
