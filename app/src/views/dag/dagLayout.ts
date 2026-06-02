/**
 * DAG layout engine — assigns (x, y) pixel coordinates to each MemoryCommit.
 *
 * Strategy:
 *   - Each branch gets its own horizontal lane (Y position).
 *   - X is derived from ts_ms, mapped linearly across the canvas width.
 *   - Merge commit nodes sit at the target branch's lane Y, at the ts_ms X.
 *   - Edges are drawn as Bezier curves connecting parent → child.
 */

import type { MemoryCommit, MemoryBranch } from "../../sui/types.js";

export interface NodeLayout {
  commit:  MemoryCommit;
  x:       number;
  y:       number;
  lane:    number;
  color:   string;
}

export interface EdgeLayout {
  fromId:  string;
  toId:    string;
  x1: number; y1: number;
  x2: number; y2: number;
  color:   string;
}

// One colour per lane index — cycles if more than 8 branches.
const LANE_COLORS = [
  "var(--lane-0)",
  "var(--lane-1)",
  "var(--lane-2)",
  "var(--lane-3)",
  "var(--lane-4)",
  "var(--lane-5)",
  "var(--lane-6)",
  "var(--lane-7)",
];

const LANE_HEIGHT  = 72;   // px between branch lanes
const NODE_RADIUS  = 9;    // px
const X_PADDING    = 80;   // px left/right padding
const TOP_PADDING  = 60;   // px above first lane
const MIN_X_STEP   = 60;   // minimum px between consecutive commits on same lane

export const NODE_R = NODE_RADIUS;

export interface DagLayout {
  nodes:      Map<string, NodeLayout>;
  edges:      EdgeLayout[];
  width:      number;
  height:     number;
  laneNames:  string[];          // index → branch name
  laneColors: Map<string, string>; // branch name → colour
}

export function computeLayout(
  commits:  MemoryCommit[],
  branches: Map<string, MemoryBranch>,
): DagLayout {
  if (commits.length === 0) {
    return { nodes: new Map(), edges: [], width: 800, height: 300, laneNames: [], laneColors: new Map() };
  }

  // ── 1. Determine lane order ──────────────────────────────────────────────
  // Order: "main" first, then other branches in order of first commit ts_ms.
  const branchFirstTs = new Map<string, number>();
  for (const c of commits) {
    const prev = branchFirstTs.get(c.branch) ?? Infinity;
    if (c.ts_ms < prev) branchFirstTs.set(c.branch, c.ts_ms);
  }

  const laneNames = Array.from(
    new Set([
      ...(branchFirstTs.has("main") ? ["main"] : []),
      ...(branches ? Array.from(branches.keys()) : []),
      ...Array.from(branchFirstTs.keys()),
    ]),
  ).filter((b) => branchFirstTs.has(b));

  // Stable sort: main first, then by first-commit ts_ms.
  laneNames.sort((a, b) => {
    if (a === "main") return -1;
    if (b === "main") return 1;
    return (branchFirstTs.get(a) ?? 0) - (branchFirstTs.get(b) ?? 0);
  });

  const laneIndex = new Map<string, number>(laneNames.map((n, i) => [n, i]));
  const laneColors = new Map<string, string>(
    laneNames.map((n, i) => [n, LANE_COLORS[i % LANE_COLORS.length]]),
  );

  // ── 2. Map timestamps to X coordinates ───────────────────────────────────
  const allTs = commits.map((c) => c.ts_ms);
  const minTs = Math.min(...allTs);
  const maxTs = Math.max(...allTs);
  const tsRange = maxTs - minTs || 1;

  // Canvas width is determined after computing X so we pick a minimum.
  // We'll use a content width, then cap it below.
  const CONTENT_W = Math.max(900, commits.length * MIN_X_STEP);

  function tsToX(ts: number): number {
    return X_PADDING + ((ts - minTs) / tsRange) * (CONTENT_W - 2 * X_PADDING);
  }

  // ── 3. Assign nodes ───────────────────────────────────────────────────────
  const nodes = new Map<string, NodeLayout>();

  for (const commit of commits) {
    const lane  = laneIndex.get(commit.branch) ?? 0;
    const color = laneColors.get(commit.branch) ?? LANE_COLORS[0];
    nodes.set(commit.id, {
      commit,
      x:     tsToX(commit.ts_ms),
      y:     TOP_PADDING + lane * LANE_HEIGHT,
      lane,
      color,
    });
  }

  // ── 4. Build edges ────────────────────────────────────────────────────────
  const edges: EdgeLayout[] = [];

  for (const commit of commits) {
    const child = nodes.get(commit.id);
    if (!child) continue;

    for (const parentId of commit.parents) {
      const parent = nodes.get(parentId);
      if (!parent) continue;

      edges.push({
        fromId: parentId,
        toId:   commit.id,
        x1: parent.x,
        y1: parent.y,
        x2: child.x,
        y2: child.y,
        // Cross-lane edges use a neutral colour; same-lane edges use the lane colour.
        color: parent.lane === child.lane ? child.color : "var(--border-strong)",
      });
    }
  }

  const height = TOP_PADDING + laneNames.length * LANE_HEIGHT + TOP_PADDING;

  return {
    nodes,
    edges,
    width:  CONTENT_W,
    height,
    laneNames,
    laneColors,
  };
}
