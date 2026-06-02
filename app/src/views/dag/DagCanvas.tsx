/**
 * DagCanvas — SVG commit graph with pan/zoom.
 *
 * Renders the full MemForks branch DAG:
 *   - Horizontal branch lanes with colour-coded labels
 *   - Commit nodes (circles / diamonds for merge commits)
 *   - Bezier edge curves connecting parent → child
 *   - Attestation badges on merge proposals
 *   - Selection + hover highlighting
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
import { COMMIT_MESSAGES } from "../../seed/demo.js";
import "./DagCanvas.css";

const MERGE_DIAMOND = NODE_R * 1.5;

export default function DagCanvas() {
  const svgRef      = useRef<SVGSVGElement>(null);
  const gRef        = useRef<SVGGElement>(null);
  const zoomRef     = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const wrapperRef  = useRef<HTMLDivElement>(null);

  const orderedCommits = useDagStore((s) => s.orderedCommits);
  const branches       = useDagStore((s) => s.branches);
  const proposals      = useDagStore((s) => s.proposals);
  const lastEvent      = useDagStore((s) => s.lastEvent);
  const newCommitIds   = useDagStore((s) => s.newCommitIds);

  const panel        = useUiStore((s) => s.panel);
  const activeBranch = useUiStore((s) => s.activeBranch);
  const hoveredId    = useUiStore((s) => s.hoveredId);
  const openCommit   = useUiStore((s) => s.openCommit);
  const setHovered   = useUiStore((s) => s.setHovered);
  const registerZoom = useUiStore((s) => s.registerZoom);
  const replayActive = useUiStore((s) => s.replayActive);
  const replayIndex  = useUiStore((s) => s.replayIndex);

  const selectedId = panel?.kind === "commit" ? panel.commit.id : null;

  // Apply seeded messages into commit objects if missing.
  // In replay mode, slice to only the commits up to replayIndex.
  const enrichedCommits = useMemo(() => {
    const source = replayActive
      ? orderedCommits.slice(0, replayIndex)
      : orderedCommits;
    return source.map((c) => ({
      ...c,
      message: c.message ?? COMMIT_MESSAGES[c.id.replace(/^0x/, "")] ?? `commit ${c.short_id}`,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedCommits, lastEvent, replayActive, replayIndex]);

  const visibleCommits = useMemo(
    () =>
      activeBranch
        ? enrichedCommits.filter((c) => c.branch === activeBranch)
        : enrichedCommits,
    [enrichedCommits, activeBranch],
  );

  const layout = useMemo(
    () => computeLayout(visibleCommits, branches),
    [visibleCommits, branches],
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

    // Fit initial view: center the graph with a slight left offset for labels.
    const ww = wrapperRef.current?.clientWidth ?? 800;
    const wh = wrapperRef.current?.clientHeight ?? 600;
    const scale = Math.min(1, (ww - 32) / layout.width);
    const tx = 16;
    const ty = (wh - layout.height * scale) / 2;
    svg.call(z.transform, zoomIdentity.translate(tx, ty).scale(scale));

    return () => { svg.on(".zoom", null); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.width, layout.height]);

  // ── Zoom-to-commit callback ───────────────────────────────────────────────
  const zoomToCommit = useCallback(
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
    registerZoom(zoomToCommit);
  }, [registerZoom, zoomToCommit]);

  // ── Click on SVG node ─────────────────────────────────────────────────────
  const handleNodeClick = useCallback(
    (e: MouseEvent, commitId: string) => {
      e.stopPropagation();
      const commit = layout.nodes.get(commitId)?.commit;
      if (commit) openCommit({ ...commit, message: COMMIT_MESSAGES[commit.id.replace(/^0x/, "")] ?? commit.message });
    },
    [layout, openCommit],
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
            const y = 60 + i * 72;
            const color = layout.laneColors.get(name) ?? "var(--fg-3)";
            const isActive = activeBranch === name;
            return (
              <g key={name} className="dag-lane-label">
                {/* Lane guide line */}
                <line
                  x1={0}
                  y1={y}
                  x2={layout.width}
                  y2={y}
                  stroke={isActive ? color : "var(--border)"}
                  strokeWidth={isActive ? 1 : 0.5}
                  strokeDasharray="4 6"
                  opacity={0.35}
                />
                {/* Label pill */}
                <rect
                  x={4}
                  y={y - 11}
                  width={name.length * 7.2 + 16}
                  height={22}
                  rx={11}
                  fill={isActive ? color : "var(--bg-2)"}
                  stroke={color}
                  strokeWidth={1}
                  opacity={isActive ? 0.95 : 0.7}
                />
                <text
                  x={12}
                  y={y + 4.5}
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

          {/* Nodes */}
          {Array.from(layout.nodes.values()).map(({ commit, x, y, color }) => {
            const isSelected  = commit.id === selectedId;
            const isHovered   = commit.id === hoveredId;
            const isDimmed    = activeBranch !== null && commit.branch !== activeBranch;
            const isMerge     = commit.is_merge;
            const isNew       = newCommitIds.has(commit.id);

            // Find active proposal for this commit.
            const proposal = Array.from(proposals.values()).find(
              (p) => p.merge_commit_id === commit.id || commit.parents.some((pid) => {
                const parentCommit = orderedCommits.find((c) => c.id === pid);
                return parentCommit && p.from_branch === parentCommit.branch && p.into_branch === commit.branch;
              }),
            );

            const nodeOpacity = isDimmed ? 0.2 : 1;

            return (
              <g
                key={commit.id}
                className={`dag-node${isNew ? " dag-node--new" : ""}`}
                onClick={(e) => handleNodeClick(e, commit.id)}
                onMouseEnter={() => setHovered(commit.id)}
                onMouseLeave={() => setHovered(null)}
                opacity={nodeOpacity}
                style={{ cursor: "pointer" }}
              >
                {isMerge ? (
                  /* Diamond for merge commits */
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
                ) : (
                  /* Circle for normal commits */
                  <g filter={isSelected || isHovered ? "url(#glow)" : undefined}>
                    {/* Outer ring on select */}
                    {(isSelected || isHovered) && (
                      <circle
                        cx={x} cy={y}
                        r={NODE_R + 5}
                        fill="none"
                        stroke={color}
                        strokeWidth={1.5}
                        opacity={0.4}
                      />
                    )}
                    <circle
                      cx={x} cy={y}
                      r={NODE_R}
                      fill={isSelected ? color : "var(--bg-1)"}
                      stroke={color}
                      strokeWidth={isSelected ? 0 : 2}
                    />
                  </g>
                )}

                {/* Attestation badge (small green/orange badge below merge nodes) */}
                {proposal && proposal.attestations.length > 0 && (
                  <g>
                    <circle
                      cx={x + 12}
                      cy={y - 12}
                      r={8}
                      fill="var(--accent)"
                      stroke="var(--bg-0)"
                      strokeWidth={1.5}
                    />
                    <text
                      x={x + 12}
                      y={y - 8.5}
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
                  {commit.short_id}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* Empty state */}
      {orderedCommits.length === 0 && (
        <div className="dag-empty">
          <p>No commits yet.</p>
          <p>Connect to a live MemoryTree or load the demo.</p>
        </div>
      )}
    </div>
  );
}
