import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import type { FlowCategory, FlowLayout } from "./layout.ts";

/**
 * The Jira workflow, drawn as hand-written SVG.
 *
 * No graph library is imported — banking CSP forbids the reactflow/xyflow/dagre
 * weight, so nodes are `<rect>`s and edges are `<line>`/`<path>`s placed by the
 * pure {@link FlowLayout} the layout module computed. This component only turns
 * numbers into elements; it decides no geometry of its own, which is why the
 * layout can be tested without a DOM.
 *
 * ACCESSIBILITY: the `<svg>` carries `role="img"` and a `<title>`/`<desc>` so a
 * screen reader announces the diagram as one figure, and the active node is
 * marked with `aria-current` plus a visible ring — colour is never the only
 * channel for "hangi adımdayız".
 */

/** Catalog key for a category's column header. */
export function categoryKey(category: FlowCategory): string {
  return `flow.category.${category}`;
}

const CATEGORY_CLASS: Readonly<Record<FlowCategory, string>> = {
  todo: "flow-node--todo",
  inprogress: "flow-node--inprogress",
  done: "flow-node--done",
  other: "flow-node--other",
};

export interface FlowDiagramProps {
  readonly layout: FlowLayout;
  /** The node id the live ticket sits on, or `null` for no highlight. */
  readonly activeId: string | null;
  /** Accessible name for the whole figure. */
  readonly title: string;
  /** Longer accessible description. */
  readonly description: string;
}

export function FlowDiagram({
  layout,
  activeId,
  title,
  description,
}: FlowDiagramProps): ReactNode {
  const t = useT();
  const titleId = "flow-diagram-title";
  const descId = "flow-diagram-desc";

  // Column headers sit above the first row; the canvas already reserves the top
  // margin, so they render at a fixed offset the layout does not need to know.
  const headerY = 14;

  return (
    <div className="flow-scroll">
      <svg
        className="flow-svg"
        viewBox={`0 0 ${layout.width} ${layout.height + 24}`}
        width={layout.width}
        height={layout.height + 24}
        role="img"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <title id={titleId}>{title}</title>
        <desc id={descId}>{description}</desc>

        <defs>
          {/* One marker per state so the arrowhead inherits the edge colour. */}
          <marker
            id="flow-arrow"
            markerWidth="9"
            markerHeight="9"
            refX="7"
            refY="4"
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <path d="M0,0 L8,4 L0,8 Z" className="flow-arrowhead" />
          </marker>
          <marker
            id="flow-arrow-back"
            markerWidth="9"
            markerHeight="9"
            refX="7"
            refY="4"
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <path d="M0,0 L8,4 L0,8 Z" className="flow-arrowhead flow-arrowhead--back" />
          </marker>
        </defs>

        {/* Column headers, one per present category. */}
        <g aria-hidden="true">
          {layout.columns.map((category, index) => {
            const node = layout.nodes.find((n) => n.column === index);
            const cx = node === undefined ? 0 : node.cx;
            return (
              <text key={category} className="flow-col-head" x={cx} y={headerY} textAnchor="middle">
                {t(categoryKey(category))}
              </text>
            );
          })}
        </g>

        {/* Edges first, so nodes paint on top of the lines. */}
        <g transform="translate(0,24)">
          {layout.edges.map((edge) => {
            if (edge.selfLoop) {
              // A small loop off the right face; drawn as a cubic that returns.
              const d = `M ${edge.x1} ${edge.y1 - 8} C ${edge.x1 + 40} ${edge.y1 - 26}, ${edge.x1 + 40} ${edge.y1 + 26}, ${edge.x2} ${edge.y2 + 8}`;
              return (
                <path
                  key={edge.id}
                  d={d}
                  className="flow-edge"
                  fill="none"
                  markerEnd="url(#flow-arrow)"
                  aria-hidden="true"
                />
              );
            }
            const backward = edge.x2 < edge.x1;
            return (
              <line
                key={edge.id}
                x1={edge.x1}
                y1={edge.y1}
                x2={edge.x2}
                y2={edge.y2}
                className={backward ? "flow-edge flow-edge--back" : "flow-edge"}
                markerEnd={backward ? "url(#flow-arrow-back)" : "url(#flow-arrow)"}
                aria-hidden="true"
              />
            );
          })}
        </g>

        {/* Nodes. */}
        <g transform="translate(0,24)">
          {layout.nodes.map((node) => {
            const active = node.id === activeId;
            return (
              <g
                key={node.id}
                className={`flow-node ${CATEGORY_CLASS[node.category]}${active ? " flow-node--active" : ""}`}
                {...(active ? { "aria-current": "step" as const } : {})}
              >
                <rect
                  x={node.x}
                  y={node.y}
                  width={node.width}
                  height={node.height}
                  rx="10"
                  className="flow-node-box"
                />
                {active && (
                  <rect
                    x={node.x - 4}
                    y={node.y - 4}
                    width={node.width + 8}
                    height={node.height + 8}
                    rx="13"
                    className="flow-node-ring"
                    fill="none"
                  />
                )}
                <text
                  x={node.cx}
                  y={node.cy}
                  className="flow-node-label"
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {node.name}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
