/**
 * DAG layout engine — assigns (x, y) pixel coordinates to each merge anchor.
 *
 * Model A: only merge anchors are on-chain nodes. Regular commits are off-chain.
 * Branches are displayed as horizontal lanes. Each merge anchor sits at the
 * target branch lane (Y) at its ts_ms (X). Edges are drawn from the from_branch
 * lane to the merge anchor, representing the merge flow.
 */

import type { MergeAnchor, MemoryBranch } from "../../sui/types.js";

export interface NodeLayout {
  anchor:  MergeAnchor;
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

const LANE_HEIGHT  = 72;
const NODE_RADIUS  = 9;
const X_PADDING    = 80;
const TOP_PADDING  = 60;
const MIN_X_STEP   = 80;

export const NODE_R = NODE_RADIUS;

export interface DagLayout {
  nodes:      Map<string, NodeLayout>;
  edges:      EdgeLayout[];
  width:      number;
  height:     number;
  laneNames:  string[];
  laneColors: Map<string, string>;
}

export function computeLayout(
  anchors:  MergeAnchor[],
  branches: Map<string, MemoryBranch>,
): DagLayout {
  if (anchors.length === 0 && branches.size === 0) {
    return { nodes: new Map(), edges: [], width: 800, height: 300, laneNames: [], laneColors: new Map() };
  }

  // ── 1. Determine lane order ──────────────────────────────────────────────
  const branchFirstTs = new Map<string, number>();
  for (const [name, b] of branches) {
    branchFirstTs.set(name, b.ts_ms);
  }
  // Also seed from anchors to catch branches not in the branch map.
  for (const a of anchors) {
    if (!branchFirstTs.has(a.branch)) branchFirstTs.set(a.branch, a.ts_ms);
  }

  const laneNames = Array.from(branchFirstTs.keys());
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
  const allTs = [...anchors.map((a) => a.ts_ms), ...Array.from(branches.values()).map((b) => b.ts_ms)];
  const minTs = Math.min(...allTs);
  const maxTs = Math.max(...allTs);
  const tsRange = maxTs - minTs || 1;

  const CONTENT_W = Math.max(900, anchors.length * MIN_X_STEP + 2 * X_PADDING);

  function tsToX(ts: number): number {
    return X_PADDING + ((ts - minTs) / tsRange) * (CONTENT_W - 2 * X_PADDING);
  }

  // ── 3. Assign nodes ───────────────────────────────────────────────────────
  const nodes = new Map<string, NodeLayout>();

  for (const anchor of anchors) {
    const lane  = laneIndex.get(anchor.branch) ?? 0;
    const color = laneColors.get(anchor.branch) ?? LANE_COLORS[0];
    nodes.set(anchor.id, {
      anchor,
      x:     tsToX(anchor.ts_ms),
      y:     TOP_PADDING + lane * LANE_HEIGHT,
      lane,
      color,
    });
  }

  // ── 4. Build edges (merge flow arrows) ───────────────────────────────────
  // For each anchor: draw an edge from the from-branch lane to the anchor node.
  const edges: EdgeLayout[] = [];

  for (const anchor of anchors) {
    const childNode = nodes.get(anchor.id);
    if (!childNode) continue;

    // Edge from the from-branch lane (at the same X as the anchor) to the anchor.
    const fromBranchLane = (() => {
      // Find what branch contributed the from_head blob — look at proposals.
      // We encode from-branch info in the anchor's parents[0] by convention.
      // For the layout we look up the branch that was the source of the merge.
      for (const b of branches.values()) {
        // from_head_blob_id matches the head of some other branch — approximate
        // by checking if any branch advanced from a head that matches parents[0].
        // For demo purposes, we skip this and just draw a generic incoming edge.
      }
      return -1;
    })();

    void fromBranchLane; // Will be used when we have full branch-head tracking.

    // For now: connect sequential merge anchors on the same branch.
    const prevAnchorOnBranch = anchors
      .filter((a) => a.branch === anchor.branch && a.ts_ms < anchor.ts_ms)
      .sort((a, b) => b.ts_ms - a.ts_ms)[0];

    if (prevAnchorOnBranch) {
      const prevNode = nodes.get(prevAnchorOnBranch.id);
      if (prevNode) {
        edges.push({
          fromId: prevAnchorOnBranch.id,
          toId:   anchor.id,
          x1: prevNode.x,
          y1: prevNode.y,
          x2: childNode.x,
          y2: childNode.y,
          color: childNode.color,
        });
      }
    }
  }

  const height = TOP_PADDING + laneNames.length * LANE_HEIGHT + TOP_PADDING;

  return { nodes, edges, width: CONTENT_W, height, laneNames, laneColors };
}
