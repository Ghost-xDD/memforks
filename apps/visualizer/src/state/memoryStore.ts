/**
 * Materialized memory facts per branch.
 *
 * In production this would be hydrated by calling mem.materialize() / mem.recall()
 * via the @memfork/core SDK. For now it's populated by the demo seed and
 * overwritten when a live connection replaces it.
 */

import { create } from "zustand";

export interface MemoryFact {
  /** Dot-path key, e.g. "error_handling.pattern" */
  key:          string;
  /** Human-readable content */
  content:      string;
  /** Short commit ID that introduced this fact */
  introduced_by: string;
  /** Full commit ID */
  introduced_by_id: string;
  /** Branch it lives on */
  branch:       string;
  /** ms timestamp of the introducing commit */
  ts_ms:        number;
}

interface MemoryState {
  /** branch name → facts list */
  facts: Map<string, MemoryFact[]>;
  setFacts: (branch: string, facts: MemoryFact[]) => void;
  allFacts: (branch: string | null) => MemoryFact[];
  reset: () => void;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  facts: new Map(),

  setFacts(branch, facts) {
    const next = new Map(get().facts);
    next.set(branch, facts);
    set({ facts: next });
  },

  allFacts(branch) {
    const { facts } = get();
    if (branch) return facts.get(branch) ?? [];
    // Merge all branches — last-write-wins by key.
    const merged = new Map<string, MemoryFact>();
    for (const list of facts.values()) {
      for (const f of list) merged.set(f.key, f);
    }
    return Array.from(merged.values()).sort((a, b) => a.key.localeCompare(b.key));
  },

  reset() { set({ facts: new Map() }); },
}));
