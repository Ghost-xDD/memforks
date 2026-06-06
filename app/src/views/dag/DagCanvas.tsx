/**
 * DagCanvas — SVG merge anchor graph with pan/zoom.
 *
 * Model A: displays merge anchors (on-chain settlements) as nodes on branch lanes.
 * Off-chain commits between merges are not shown here — they live in Walrus blobs
 * and can be explored via the blob inspector.
 *
 * Renders:
 *   - Horizontal branch lanes with colour-coded labels
 *   - Merge anchor nodes (diamonds, always a merge)
 *   - Edges connecting sequential anchors on the same branch
 *   - Attestation badge counts
 *   - Pan/zoom via d3-zoom
 */

import {
  useRef,
  useEffect,
  useMemo,
  useCallback,
  type MouseEvent,
} from "react";
import { select } from "d3-selection";
import { zoom, zoomIdentity } from "d3-zoom";
import type { ZoomBehavior } from "d3-zoom";
import { useDagStore } from "../../state/dagStore.js";
import { useUiStore } from "../../state/uiStore.js";
import { computeLayout, NODE_R } from "./dagLayout.js";
import "./DagCanvas.css";

const MERGE_DIAMOND = NODE_R * 1.5;

export default function DagCanvas() {
  const svgRef     = useRef<SVGSVGElement>(null);
  const gRef       = useRef<SVGGElement>(null);
  const zoomRef    = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const orderedAnchors = useDagStore((s) => s.orderedAnchors);
  const branches       = useDagStore((s) => s.branches);
  const proposals      = useDagStore((s) => s.proposals);
  const lastEvent      = useDagStore((s) => s.lastEvent);
  const newAnchorIds   = useDagStore((s) => s.newAnchorIds);

  const panel        = useUiStore((s) => s.panel);
  const activeBranch = useUiStore((s) => s.activeBranch);
  const hoveredId    = useUiStore((s) => s.hoveredId);
  const openAnchor   = useUiStore((s) => s.openAnchor);
  const setHovered   = useUiStore((s) => s.setHovered);
  const registerZoom = useUiStore((s) => s.registerZoom);
  const replayActive = useUiStore((s) => s.replayActive);
  const replayIndex  = useUiStore((s) => s.replayIndex);

  const selectedId = panel?.kind === "anchor" ? panel.anchor.id : null;

  const visibleAnchors = useMemo(() => {
    const source = replayActive ? orderedAnchors.slice(0, replayIndex) : orderedAnchors;
    return activeBranch ? source.filter((a) => a.branch === activeBranch) : source;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedAnchors, lastEvent, replayActive, replayIndex, activeBranch]);

  const layout = useMemo(
    () => computeLayout(visibleAnchors, branches),
    [visibleAnchors, branches],
  );

  // ── Zoom setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;
    const svg = select(svgRef.current);
    const g   = select(gRef.current);

    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 3])
      .on("zoom", (event) => {
        g.attr("transform", event.transform.toString());
      });

    svg.call(z);
    zoomRef.current = z;

    const ww = wrapperRef.current?.clientWidth ?? 800;
    const wh = wrapperRef.current?.clientHeight ?? 600;
    const scale = Math.min(1, (ww - 32) / layout.width);
    const tx = 16;
    const ty = (wh - layout.height * scale) / 2;
    svg.call(z.transform, zoomIdentity.translate(tx, ty).scale(scale));

    return () => { svg.on(".zoom", null); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.width, layout.height]);

  // ── Zoom-to-anchor callback ───────────────────────────────────────────────
  const zoomToAnchor = useCallback(
    (id: string) => {
      const node = layout.nodes.get(id);
      if (!node || !svgRef.current || !zoomRef.current) return;
      const ww = wrapperRef.current?.clientWidth ?? 800;
      const wh = wrapperRef.current?.clientHeight ?? 600;
      const scale = 1.2;
      const tx = ww / 2 - node.x * scale;
      const ty = wh / 2 - node.y * scale;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (select(svgRef.current) as any)
        .transition()
        .duration(500)
        .call(zoomRef.current.transform, zoomIdentity.translate(tx, ty).scale(scale));
    },
    [layout],
  );

  useEffect(() => {
    registerZoom(zoomToAnchor);
  }, [registerZoom, zoomToAnchor]);

  // ── Click on SVG node ─────────────────────────────────────────────────────
  const handleNodeClick = useCallback(
    (e: MouseEvent, anchorId: string) => {
      e.stopPropagation();
      const anchor = layout.nodes.get(anchorId)?.anchor;
      if (anchor) openAnchor(anchor);
    },
    [layout, openAnchor],
  );

  const handleBgClick = useCallback(() => {
    useUiStore.getState().closeDrawer();
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div ref={wrapperRef} className="dag-canvas-wrapper" onClick={handleBgClick}>
      <svg
        ref={svgRef}
        className="dag-canvas-svg"
        style={{ width: "100%", height: "100%" }}
      >
        <defs>
          <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="1.6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <marker
            id="arrow"
            viewBox="0 0 8 8"
            refX="6"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L0,8 L8,4 z" fill="var(--border-strong)" />
          </marker>
        </defs>

        <g ref={gRef}>
          {/* Branch lane labels */}
          {layout.laneNames.map((name, i) => {
            const y       = 60 + i * 72;
            const color   = layout.laneColors.get(name) ?? "var(--fg-3)";
            const isActive = activeBranch === name;
            return (
              <g key={name} className="dag-lane-label">
                <line
                  x1={0} y1={y} x2={layout.width} y2={y}
                  stroke={isActive ? color : "var(--border)"}
                  strokeWidth={isActive ? 1 : 0.5}
                  strokeDasharray="4 6"
                  opacity={0.35}
                />
                <rect
                  x={4} y={y - 11}
                  width={name.length * 7.2 + 16}
                  height={22}
                  rx={11}
                  fill={isActive ? color : "var(--bg-2)"}
                  stroke={color}
                  strokeWidth={1}
                  opacity={isActive ? 0.95 : 0.7}
                />
                <text
                  x={12} y={y + 4.5}
                  fontSize={11}
                  fontFamily="var(--font-mono)"
                  fill={isActive ? "var(--bg-0)" : color}
                  fontWeight={isActive ? 600 : 400}
                >
                  {name}
                </text>
              </g>
            );
          })}

          {/* Edges */}
          {layout.edges.map((edge, i) => {
            const dx = Math.abs(edge.x2 - edge.x1) * 0.5;
            const d = `M${edge.x1},${edge.y1} C${edge.x1 + dx},${edge.y1} ${edge.x2 - dx},${edge.y2} ${edge.x2},${edge.y2}`;
            const isHighlighted =
              edge.fromId === hoveredId || edge.toId === hoveredId ||
              edge.fromId === selectedId || edge.toId === selectedId;
            return (
              <path
                key={i}
                d={d}
                fill="none"
                stroke={edge.color}
                strokeWidth={isHighlighted ? 2 : 1.2}
                opacity={isHighlighted ? 0.9 : 0.4}
                strokeLinecap="round"
                className="dag-edge"
              />
            );
          })}

          {/* Anchor nodes */}
          {Array.from(layout.nodes.values()).map(({ anchor, x, y, color }) => {
            const isSelected = anchor.id === selectedId;
            const isHovered  = anchor.id === hoveredId;
            const isDimmed   = activeBranch !== null && anchor.branch !== activeBranch;
            const isNew      = newAnchorIds.has(anchor.id);
            const proposal   = proposals.get(anchor.proposal_id);

            return (
              <g
                key={anchor.id}
                className={`dag-node${isNew ? " dag-node--new" : ""}`}
                onClick={(e) => handleNodeClick(e, anchor.id)}
                onMouseEnter={() => setHovered(anchor.id)}
                onMouseLeave={() => setHovered(null)}
                opacity={isDimmed ? 0.2 : 1}
                style={{ cursor: "pointer" }}
              >
                {/* Diamond for all merge anchors */}
                <g filter={isSelected || isHovered ? "url(#glow)" : undefined}>
                  <rect
                    x={x - MERGE_DIAMOND}
                    y={y - MERGE_DIAMOND}
                    width={MERGE_DIAMOND * 2}
                    height={MERGE_DIAMOND * 2}
                    rx={3}
                    fill={isSelected ? color : "var(--bg-1)"}
                    stroke={color}
                    strokeWidth={isSelected ? 2.5 : 2}
                    transform={`rotate(45, ${x}, ${y})`}
                  />
                </g>

                {/* Attestation badge */}
                {proposal && proposal.attestations.length > 0 && (
                  <g>
                    <circle
                      cx={x + 12} cy={y - 12}
                      r={8}
                      fill="var(--accent)"
                      stroke="var(--bg-0)"
                      strokeWidth={1.5}
                    />
                    <text
                      x={x + 12} y={y - 8.5}
                      textAnchor="middle"
                      fontSize={8}
                      fontFamily="var(--font-mono)"
                      fontWeight={700}
                      fill="var(--bg-0)"
                    >
                      {proposal.attestations.length}
                    </text>
                  </g>
                )}

                {/* Short hash label */}
                <text
                  x={x}
                  y={y + NODE_R + 14}
                  textAnchor="middle"
                  fontSize={9.5}
                  fontFamily="var(--font-mono)"
                  fill={isSelected ? color : "var(--fg-3)"}
                  className="dag-node-hash"
                >
                  {anchor.id.slice(2, 9)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* Empty state */}
      {orderedAnchors.length === 0 && (
        <div className="dag-empty">
          <p>No merge anchors yet.</p>
          <p>Commits live off-chain in Walrus blobs — merges appear here when settled.</p>
        </div>
      )}
    </div>
  );
}
