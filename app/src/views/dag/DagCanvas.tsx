/**
 * DagCanvas — SVG DAG visualization.
 *
 * Off-chain commits  → filled circles.
 * On-chain merge anchors → diamond shapes.
 * Both are clickable (anchors open the AnchorInspector drawer).
 */

import { useCallback, useEffect, useRef } from "react";
import { useDagStore } from "../../state/dagStore.js";
import { useUiStore }  from "../../state/uiStore.js";
import { computeLayout, NODE_R } from "./dagLayout.js";
import type { NodeLayout } from "./dagLayout.js";
import "./DagCanvas.css";

// ─── Diamond helper ────────────────────────────────────────────────────────────
function diamond(cx: number, cy: number, r: number): string {
  return `M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy}Z`;
}

const LANE_LABEL_W = 90;

export default function DagCanvas() {
  const orderedCommits = useDagStore((s) => s.orderedCommits);
  const orderedAnchors = useDagStore((s) => s.orderedAnchors);
  const branches       = useDagStore((s) => s.branches);
  const newAnchorIds   = useDagStore((s) => s.newAnchorIds);
  const panel          = useUiStore((s)  => s.panel);
  const openAnchor     = useUiStore((s)  => s.openAnchor);
  const registerZoom   = useUiStore((s)  => s.registerZoom);
  const activeBranch   = useUiStore((s)  => s.activeBranch);
  const replayActive   = useUiStore((s)  => s.replayActive);
  const replayIndex    = useUiStore((s)  => s.replayIndex);

  const selectedId = panel?.kind === "anchor" ? panel.anchor.id : null;
  const svgRef     = useRef<SVGSVGElement>(null);

  const visibleCommits = (() => {
    const filtered = activeBranch
      ? orderedCommits.filter((c) => c.branch === activeBranch)
      : orderedCommits;
    return replayActive ? filtered.slice(0, replayIndex) : filtered;
  })();

  const visibleAnchors = (() => {
    const filtered = activeBranch
      ? orderedAnchors.filter((a) => a.branch === activeBranch)
      : orderedAnchors;
    return replayActive ? filtered.slice(0, Math.max(0, replayIndex - visibleCommits.length)) : filtered;
  })();

  const layout = computeLayout(visibleCommits, visibleAnchors, branches);
  const { nodes, edges, width, height, laneNames, laneColors } = layout;

  // Auto-scroll to the latest anchor that appears new.
  useEffect(() => {
    if (!svgRef.current || newAnchorIds.size === 0) return;
    const firstNew = orderedAnchors.find((a) => newAnchorIds.has(a.id));
    if (!firstNew) return;
    const n = nodes.get(firstNew.id);
    if (!n) return;
    const container = svgRef.current.parentElement;
    if (container) container.scrollLeft = Math.max(0, n.x - container.clientWidth / 2);
  }, [newAnchorIds, orderedAnchors, nodes]);

  // Register the zoom callback so openAnchor() can scroll the canvas.
  useEffect(() => {
    registerZoom((anchorId: string) => {
      if (!svgRef.current) return;
      const n = nodes.get(anchorId);
      if (!n) return;
      const container = svgRef.current.parentElement;
      if (container) container.scrollLeft = Math.max(0, n.x - container.clientWidth / 2);
    });
  }, [registerZoom, nodes]);

  const handleNodeClick = useCallback(
    (n: NodeLayout) => {
      if (n.kind === "anchor" && n.anchor) openAnchor(n.anchor);
    },
    [openAnchor],
  );

  const totalW = width + LANE_LABEL_W;

  return (
    <div className="dag-canvas-scroll">
      <svg
        ref={svgRef}
        className="dag-canvas"
        width={totalW}
        height={height}
        viewBox={`0 0 ${totalW} ${height}`}
        aria-label="Memory DAG"
      >
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* ── Lane backgrounds ──────────────────────────────────────────── */}
        {laneNames.map((name, i) => {
          const y = 60 - 28 + i * 72;
          return (
            <g key={name}>
              <rect
                x={LANE_LABEL_W}
                y={y}
                width={width}
                height={72}
                fill={i % 2 === 0 ? "var(--lane-stripe-even)" : "var(--lane-stripe-odd)"}
              />
              <text
                x={LANE_LABEL_W - 8}
                y={y + 36}
                textAnchor="end"
                dominantBaseline="middle"
                className="dag-lane-label"
                fill={laneColors.get(name)}
              >
                {name.length > 12 ? `${name.slice(0, 10)}…` : name}
              </text>
            </g>
          );
        })}

        {/* ── Edges ─────────────────────────────────────────────────────── */}
        <g className="dag-edges">
          {edges.map((e) => {
            const x1 = e.x1 + LANE_LABEL_W;
            const x2 = e.x2 + LANE_LABEL_W;
            const cp1x = x1 + (x2 - x1) * 0.5;
            const cp2x = x1 + (x2 - x1) * 0.5;
            return (
              <path
                key={`${e.fromId}-${e.toId}`}
                d={`M${x1},${e.y1} C${cp1x},${e.y1} ${cp2x},${e.y2} ${x2},${e.y2}`}
                fill="none"
                stroke={e.color}
                strokeWidth={1.5}
                strokeOpacity={0.55}
              />
            );
          })}
        </g>

        {/* ── Nodes ─────────────────────────────────────────────────────── */}
        <g className="dag-nodes">
          {Array.from(nodes.values()).map((n) => {
            const cx = n.x + LANE_LABEL_W;
            const cy = n.y;
            const isSelected = n.id === selectedId;
            const isNew      = n.kind === "anchor" && newAnchorIds.has(n.id);
            const color      = n.color;
            const clickable  = n.kind === "anchor";

            return (
              <g
                key={n.id}
                className={`dag-node ${n.kind} ${isSelected ? "selected" : ""} ${clickable ? "clickable" : ""} ${isNew ? "dag-node--new" : ""}`}
                onClick={() => handleNodeClick(n)}
                tabIndex={clickable ? 0 : -1}
                role={clickable ? "button" : undefined}
                aria-label={n.kind === "anchor"
                  ? `Merge anchor ${n.id.slice(2, 8)} on ${n.branch}`
                  : `Commit ${n.id.slice(0, 8)} on ${n.branch}`}
                onKeyDown={(e) => { if (e.key === "Enter") handleNodeClick(n); }}
              >
                {n.kind === "anchor" ? (
                  <>
                    {isNew && <path d={diamond(cx, cy, NODE_R + 6)} fill={color} opacity={0.2} filter="url(#glow)" />}
                    <path
                      d={diamond(cx, cy, NODE_R + (isSelected ? 3 : 0))}
                      fill={isSelected ? color : "var(--bg-elevated)"}
                      stroke={color}
                      strokeWidth={isSelected ? 2.5 : 1.5}
                    />
                    <title>{`Merge anchor · ${n.branch} · ${new Date(n.ts_ms).toLocaleString()}`}</title>
                  </>
                ) : (
                  <>
                    <circle
                      cx={cx} cy={cy}
                      r={NODE_R - 3}
                      fill={color}
                      opacity={0.75}
                    />
                    <title>{`Commit ${n.id.slice(0, 8)} · ${n.branch} · ${n.commit?.message ?? ""}`}</title>
                  </>
                )}
              </g>
            );
          })}
        </g>

        {/* ── Empty state ───────────────────────────────────────────────── */}
        {nodes.size === 0 && (
          <text
            x={totalW / 2} y={height / 2}
            textAnchor="middle" dominantBaseline="middle"
            className="dag-empty-text"
          >
            No history yet
          </text>
        )}
      </svg>
    </div>
  );
}
