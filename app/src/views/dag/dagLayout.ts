/**
 * DAG layout engine — positions both off-chain commit blobs and on-chain merge anchors.
 *
 * Model A:
 *   - Off-chain commits (circles) come from /api/history via MemWal.
 *   - On-chain merge anchors (diamonds) come from MergeFinalized events.
 *   - Both share the same X (timestamp) / Y (branch lane) coordinate system.
 *   - Edges connect commit → parent commit via parent_blob_ids,
 *     and commit → merge anchor via the anchor's parents[].
 */

import type { OffChainCommit, MergeAnchor, MemoryBranch } from "../../sui/types.js";

export type NodeKind = "commit" | "anchor";

export interface NodeLayout {
  id:     string;       // blob_id for commits, merge_commit_id for anchors
  kind:   NodeKind;
  commit?: OffChainCommit;
  anchor?: MergeAnchor;
  x:      number;
  y:      number;
  lane:   number;
  color:  string;
  branch: string;
  ts_ms:  number;
}

export interface EdgeLayout {
  fromId: string;
  toId:   string;
  x1: number; y1: number;
  x2: number; y2: number;
  color: string;
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

const LANE_HEIGHT = 72;
const NODE_RADIUS = 9;
const X_PADDING   = 80;
const TOP_PADDING = 60;
const MIN_X_STEP  = 50;

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
  commits:  OffChainCommit[],
  anchors:  MergeAnchor[],
  branches: Map<string, MemoryBranch>,
): DagLayout {
  if (commits.length === 0 && anchors.length === 0 && branches.size === 0) {
    return { nodes: new Map(), edges: [], width: 800, height: 300, laneNames: [], laneColors: new Map() };
  }

  // ── 1. Lane order ────────────────────────────────────────────────────────
  const branchFirstTs = new Map<string, number>();
  for (const [name, b] of branches) branchFirstTs.set(name, b.ts_ms);
  for (const c of commits) {
    const prev = branchFirstTs.get(c.branch) ?? Infinity;
    if (c.ts_ms < prev) branchFirstTs.set(c.branch, c.ts_ms);
  }
  for (const a of anchors) {
    if (!branchFirstTs.has(a.branch)) branchFirstTs.set(a.branch, a.ts_ms);
  }

  const laneNames = Array.from(branchFirstTs.keys()).sort((a, b) => {
    if (a === "main") return -1;
    if (b === "main") return 1;
    return (branchFirstTs.get(a) ?? 0) - (branchFirstTs.get(b) ?? 0);
  });

  const laneIndex  = new Map(laneNames.map((n, i) => [n, i]));
  const laneColors = new Map(laneNames.map((n, i) => [n, LANE_COLORS[i % LANE_COLORS.length]]));

  // ── 2. Timestamp → X ────────────────────────────────────────────────────
  const allTs = [
    ...commits.map((c) => c.ts_ms),
    ...anchors.map((a) => a.ts_ms),
    ...Array.from(branches.values()).map((b) => b.ts_ms),
  ];
  if (allTs.length === 0) allTs.push(Date.now());
  const minTs     = Math.min(...allTs);
  const maxTs     = Math.max(...allTs);
  const tsRange   = maxTs - minTs || 1;
  const totalNodes = commits.length + anchors.length;
  const CONTENT_W = Math.max(900, totalNodes * MIN_X_STEP + 2 * X_PADDING);

  function tsToX(ts: number): number {
    return X_PADDING + ((ts - minTs) / tsRange) * (CONTENT_W - 2 * X_PADDING);
  }

  // ── 3. Build nodes ───────────────────────────────────────────────────────
  const nodes = new Map<string, NodeLayout>();

  for (const c of commits) {
    const lane  = laneIndex.get(c.branch) ?? 0;
    const color = laneColors.get(c.branch) ?? LANE_COLORS[0];
    nodes.set(c.blob_id, {
      id: c.blob_id, kind: "commit", commit: c,
      x: tsToX(c.ts_ms), y: TOP_PADDING + lane * LANE_HEIGHT,
      lane, color, branch: c.branch, ts_ms: c.ts_ms,
    });
  }

  for (const a of anchors) {
    const lane  = laneIndex.get(a.branch) ?? 0;
    const color = laneColors.get(a.branch) ?? LANE_COLORS[0];
    nodes.set(a.id, {
      id: a.id, kind: "anchor", anchor: a,
      x: tsToX(a.ts_ms), y: TOP_PADDING + lane * LANE_HEIGHT,
      lane, color, branch: a.branch, ts_ms: a.ts_ms,
    });
  }

  // ── 4. Edges ─────────────────────────────────────────────────────────────
  const edges: EdgeLayout[] = [];

  // Commit → parent commit edges (from parent_blob_ids)
  for (const c of commits) {
    const child = nodes.get(c.blob_id);
    if (!child) continue;
    for (const pid of c.parent_blob_ids) {
      const parent = nodes.get(pid);
      if (!parent) continue;
      edges.push({
        fromId: pid, toId: c.blob_id,
        x1: parent.x, y1: parent.y, x2: child.x, y2: child.y,
        color: parent.lane === child.lane ? child.color : "var(--border-strong)",
      });
    }
  }

  // Merge anchor → consumed branch-tip edges (anchor.parents are blob IDs)
  for (const a of anchors) {
    const anchorNode = nodes.get(a.id);
    if (!anchorNode) continue;
    for (const parentBlobId of a.parents) {
      if (!parentBlobId) continue;
      const parent = nodes.get(parentBlobId);
      if (!parent) continue;
      edges.push({
        fromId: parentBlobId, toId: a.id,
        x1: parent.x, y1: parent.y, x2: anchorNode.x, y2: anchorNode.y,
        color: "var(--border-strong)",
      });
    }
  }

  const height = TOP_PADDING + laneNames.length * LANE_HEIGHT + TOP_PADDING;
  return { nodes, edges, width: CONTENT_W, height, laneNames, laneColors };
}
