/**
 * UI state — selected nodes, active drawer panel, branch filter, replay mode.
 *
 * Model A: the "commit" inspector now opens a MergeAnchor (on-chain merge anchor),
 * not a regular commit. Regular commits are off-chain blobs visible via MemWal.
 */

import { create } from "zustand";
import type { MergeAnchor, MergeProposal } from "../sui/types.js";

export type ActiveView = "memory" | "history" | "merges" | "graph";

export type DrawerPanel =
  | { kind: "anchor";   anchor:   MergeAnchor   }
  | { kind: "proposal"; proposal: MergeProposal  }
  | null;

interface UiState {
  activeView:     ActiveView;
  setActiveView:  (v: ActiveView) => void;

  panel:          DrawerPanel;
  openAnchor:     (c: MergeAnchor)    => void;
  openProposal:   (p: MergeProposal)  => void;
  closeDrawer:    ()                  => void;

  activeBranch:    string | null;
  setActiveBranch: (name: string | null) => void;

  hoveredId:  string | null;
  setHovered: (id: string | null) => void;

  replayActive: boolean;
  replayIndex:  number;
  startReplay:  ()  => void;
  stepReplay:   ()  => void;
  stopReplay:   ()  => void;

  zoomToAnchor:   ((id: string) => void) | null;
  registerZoom:   (fn: (id: string) => void) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  activeView:   "memory",
  panel:        null,
  activeBranch: null,
  hoveredId:    null,
  replayActive: false,
  replayIndex:  0,
  zoomToAnchor: null,

  setActiveView(v) { set({ activeView: v }); },

  openAnchor(c) {
    set({ panel: { kind: "anchor", anchor: c } });
    get().zoomToAnchor?.(c.id);
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

  registerZoom(fn) { set({ zoomToAnchor: fn }); },
}));
