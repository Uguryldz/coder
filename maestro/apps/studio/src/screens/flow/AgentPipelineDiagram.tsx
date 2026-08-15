import type { ReactNode } from "react";
import type { PipelineActor } from "./agentPipeline.ts";
import type { PipelineLayout, PipelineNode } from "./pipelineLayout.ts";

/**
 * The agent pipeline, drawn as hand-written SVG (no graph library — bank CSP).
 *
 * Two orthogonal channels colour a node:
 *  - the ACTOR (maestro / agent / human) sets its base fill, so an operator sees
 *    at a glance who owns each step, and
 *  - the live STATE of that step in the running pilot (`liveState`) sets a ring:
 *    çalışıyor pulses, onay is amber, tamam green, hata red. A step with no live
 *    state (no run, or not reached yet) shows no ring — the map is legible even
 *    when nothing is running.
 *
 * ACCESSIBILITY: the figure is one `role="img"` with a `<title>`/`<desc>`; the
 * active (running/gate) node carries `aria-current="step"`; state is never
 * colour-only — the running node also gets a visible ring and its state word is
 * rendered as text under the title.
 */

/** Live per-step state as the pilot reports it, keyed by step id. */
export type LiveStateMap = Readonly<Record<string, LiveStepState | undefined>>;

/** Mirror of pilot `StepState` (apps/pilot/src/state.ts). */
export type LiveStepState = "bekliyor" | "calisiyor" | "onay" | "tamam" | "hata";

const ACTOR_CLASS: Readonly<Record<PipelineActor, string>> = {
  maestro: "pl-node--maestro",
  agent: "pl-node--agent",
  human: "pl-node--human",
};

const STATE_CLASS: Readonly<Record<LiveStepState, string>> = {
  bekliyor: "pl-node--wait",
  calisiyor: "pl-node--run",
  onay: "pl-node--gate",
  tamam: "pl-node--done",
  hata: "pl-node--err",
};

export interface AgentPipelineDiagramProps {
  readonly layout: PipelineLayout;
  /** Live step states from the running pilot (empty when nothing runs). */
  readonly live: LiveStateMap;
  /** The step id that is running or has an open gate — gets `aria-current`. */
  readonly activeId: string | null;
  readonly title: string;
  readonly description: string;
  /** Localized state words, for the text channel under a node. */
  readonly stateLabel: (state: LiveStepState) => string;
}

export function AgentPipelineDiagram({
  layout,
  live,
  activeId,
  title,
  description,
  stateLabel,
}: AgentPipelineDiagramProps): ReactNode {
  const titleId = "pl-diagram-title";
  const descId = "pl-diagram-desc";

  return (
    <div className="pl-scroll">
      <svg
        className="pl-svg"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        role="img"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <title id={titleId}>{title}</title>
        <desc id={descId}>{description}</desc>

        <defs>
          <marker
            id="pl-arrow"
            markerWidth="9"
            markerHeight="9"
            refX="7"
            refY="4"
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <path d="M0,0 L8,4 L0,8 Z" className="pl-arrowhead" />
          </marker>
          <marker
            id="pl-arrow-branch"
            markerWidth="9"
            markerHeight="9"
            refX="7"
            refY="4"
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <path d="M0,0 L8,4 L0,8 Z" className="pl-arrowhead pl-arrowhead--branch" />
          </marker>
        </defs>

        {/* Edges first so nodes paint on top. */}
        <g>
          {layout.edges.map((edge) => {
            const cls =
              edge.kind === "main"
                ? "pl-edge"
                : edge.kind === "back"
                  ? "pl-edge pl-edge--back"
                  : "pl-edge pl-edge--out";
            const marker =
              edge.kind === "main" ? "url(#pl-arrow)" : "url(#pl-arrow-branch)";
            return (
              <g key={edge.id}>
                <line
                  x1={edge.x1}
                  y1={edge.y1}
                  x2={edge.x2}
                  y2={edge.y2}
                  className={cls}
                  markerEnd={marker}
                  aria-hidden="true"
                />
                {edge.label !== null && (
                  <text
                    x={(edge.x1 + edge.x2) / 2}
                    y={(edge.y1 + edge.y2) / 2 - 4}
                    className="pl-edge-label"
                    textAnchor="middle"
                    aria-hidden="true"
                  >
                    {edge.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {/* Nodes. */}
        <g>
          {layout.nodes.map((node) => (
            <PipelineNodeShape
              key={node.id}
              node={node}
              state={live[node.id]}
              active={node.id === activeId}
              stateLabel={stateLabel}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

interface NodeShapeProps {
  readonly node: PipelineNode;
  readonly state: LiveStepState | undefined;
  readonly active: boolean;
  readonly stateLabel: (state: LiveStepState) => string;
}

function PipelineNodeShape({ node, state, active, stateLabel }: NodeShapeProps): ReactNode {
  const stateCls = state === undefined ? "" : ` ${STATE_CLASS[state]}`;
  return (
    <g
      className={`pl-node ${ACTOR_CLASS[node.actor]}${stateCls}${active ? " pl-node--active" : ""}`}
      {...(active ? { "aria-current": "step" as const } : {})}
    >
      <rect
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        rx="12"
        className="pl-node-box"
      />
      {active && (
        <rect
          x={node.x - 4}
          y={node.y - 4}
          width={node.width + 8}
          height={node.height + 8}
          rx="15"
          className="pl-node-ring"
          fill="none"
        />
      )}

      {/* Ordinal badge (matches the pilot step id). */}
      <circle cx={node.x + 16} cy={node.y + 16} r="11" className="pl-node-badge" />
      <text
        x={node.x + 16}
        y={node.y + 16}
        className="pl-node-badge-text"
        textAnchor="middle"
        dominantBaseline="central"
      >
        {node.ord}
      </text>

      {/* Role (who) — the headline. */}
      <text x={node.cx} y={node.y + 30} className="pl-node-role" textAnchor="middle">
        {node.role}
      </text>
      {/* Title (what step). */}
      <text x={node.cx} y={node.y + 48} className="pl-node-title" textAnchor="middle">
        {node.title}
      </text>
      {/* Live state word, only when the pilot reports one for this step. */}
      {state !== undefined && (
        <text x={node.cx} y={node.y + 64} className="pl-node-state" textAnchor="middle">
          {stateLabel(state)}
        </text>
      )}
    </g>
  );
}
