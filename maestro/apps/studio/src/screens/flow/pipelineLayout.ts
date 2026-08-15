/**
 * Pure layout for the AGENT pipeline diagram.
 *
 * Same discipline as the Jira-workflow `layout.ts`: hand-computed geometry, zero
 * graph libraries (bank/CSP forbids reactflow/dagre), no React/DOM/clock. Same
 * input → same coordinates, so the tests pin the numbers directly.
 *
 * The input is the fixed {@link AGENT_PIPELINE} (nine steps). The steps flow
 * left-to-right and WRAP: after `COLS` per row the flow drops to the next row and
 * continues, so a nine-step chain reads as a compact boustrophedon rather than a
 * canvas that scrolls off the right edge. The wrap direction alternates (row 0
 * L→R, row 1 R→L, …) so consecutive steps are always physically adjacent and the
 * connecting edge is short — the "snake" reading Uğur's sketch used.
 *
 * Two edge kinds:
 *  - the MAIN chain (step i → i+1), following the snake, and
 *  - BRANCHES declared on a step (İADE leaves the flow; a review "red" routes
 *    back to an earlier step). Branches are drawn distinctly by the component.
 */

import { AGENT_PIPELINE, type PipelineActor, type PipelineBranch } from "./agentPipeline.ts";

/** Steps per row before the flow wraps to the next line. */
export const COLS = 3;

const NODE_W = 168;
const NODE_H = 76;
const GAP_X = 56; // horizontal space between node boxes
const GAP_Y = 84; // vertical space between rows (room for branch labels)
const PAD = 20; // canvas padding

/** A placed pipeline node. */
export interface PipelineNode {
  readonly id: string;
  readonly actor: PipelineActor;
  readonly role: string;
  readonly title: string;
  readonly task: string;
  readonly branches: readonly PipelineBranch[];
  /** 1-based ordinal shown as the badge ("1".."9") — equals the pilot step id. */
  readonly ord: string;
  readonly col: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly cx: number;
  readonly cy: number;
}

/** Where an edge attaches, and how it is drawn. */
export interface PipelineEdge {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string | null; // null = branch that leaves the flow (İADE)
  readonly kind: "main" | "back" | "out";
  readonly label: string | null;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface PipelineLayout {
  readonly nodes: readonly PipelineNode[];
  readonly edges: readonly PipelineEdge[];
  readonly width: number;
  readonly height: number;
}

/** Column x-origin for a given column index. */
function colX(col: number): number {
  return PAD + col * (NODE_W + GAP_X);
}

/** Row y-origin for a given row index. */
function rowY(row: number): number {
  return PAD + row * (NODE_H + GAP_Y);
}

/**
 * Place the nine steps on the snake grid and route the edges.
 *
 * Boustrophedon: even rows read left→right, odd rows right→left, so the last
 * node of a row sits directly above the first node of the next and the wrap edge
 * is a short vertical drop. The visual column of a node therefore differs from
 * its index-within-row on odd rows — computed here so the component stays dumb.
 */
export function layoutPipeline(): PipelineLayout {
  const steps = AGENT_PIPELINE;

  const nodes: PipelineNode[] = steps.map((step, index) => {
    const row = Math.floor(index / COLS);
    const within = index % COLS;
    // Odd rows are reversed so the snake stays contiguous.
    const col = row % 2 === 0 ? within : COLS - 1 - within;
    const x = colX(col);
    const y = rowY(row);
    return {
      id: step.id,
      actor: step.actor,
      role: step.role,
      title: step.title,
      task: step.task,
      branches: step.branches,
      ord: step.id,
      col,
      row,
      x,
      y,
      width: NODE_W,
      height: NODE_H,
      cx: x + NODE_W / 2,
      cy: y + NODE_H / 2,
    };
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: PipelineEdge[] = [];

  // Main chain: each step to the next, following the snake.
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (a === undefined || b === undefined) continue;
    const sameRow = a.row === b.row;
    if (sameRow) {
      // Horizontal segment between right/left faces, honouring snake direction.
      const leftToRight = b.cx > a.cx;
      edges.push({
        id: `main-${a.id}-${b.id}`,
        fromId: a.id,
        toId: b.id,
        kind: "main",
        label: null,
        x1: leftToRight ? a.x + a.width : a.x,
        y1: a.cy,
        x2: leftToRight ? b.x : b.x + b.width,
        y2: b.cy,
      });
    } else {
      // Wrap: vertical drop from the bottom face of a to the top face of b
      // (they share a column by construction).
      edges.push({
        id: `main-${a.id}-${b.id}`,
        fromId: a.id,
        toId: b.id,
        kind: "main",
        label: null,
        x1: a.cx,
        y1: a.y + a.height,
        x2: b.cx,
        y2: b.y,
      });
    }
  }

  // Branches declared on steps.
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    node.branches.forEach((branch, bi) => {
      if (branch.kind === "back") {
        // A review "red": route from the left face back to the previous step's
        // right/left face. We resolve the target by step id when the label names
        // it; otherwise fall back to the immediately preceding step.
        const target = resolveBackTarget(byId, node.id);
        edges.push({
          id: `br-${node.id}-${bi}`,
          fromId: node.id,
          toId: target?.id ?? null,
          kind: "back",
          label: branch.label,
          x1: node.x,
          y1: node.cy + 12,
          x2: target === undefined ? node.x - GAP_X : target.cx,
          y2: target === undefined ? node.cy + 12 : target.cy + 12,
        });
      } else {
        // İADE / leaves the flow: a short stub dropping below the node.
        edges.push({
          id: `br-${node.id}-${bi}`,
          fromId: node.id,
          toId: null,
          kind: "out",
          label: branch.label,
          x1: node.cx,
          y1: node.y + node.height,
          x2: node.cx,
          y2: node.y + node.height + 30,
        });
      }
    });
  }

  const rows = Math.ceil(steps.length / COLS);
  const width = PAD * 2 + COLS * NODE_W + (COLS - 1) * GAP_X;
  const height = PAD * 2 + rows * NODE_H + (rows - 1) * GAP_Y + 34; // +34 for out-stubs
  return { nodes, edges, width, height };
}

/**
 * Resolve the target of a "back" branch: the numerically-previous step id.
 *
 * The analysis review (step 3) rejects to re-analysis, which in the pilot re-runs
 * from the analysis production — step "2". Rather than parse the free-text label,
 * we route to id `String(Number(id) - 1)`, which is exactly step 2 for step 3 and
 * stays correct if a future back-branch is added elsewhere.
 */
function resolveBackTarget(
  byId: ReadonlyMap<string, PipelineNode>,
  fromId: string,
): PipelineNode | undefined {
  const prev = String(Number(fromId) - 1);
  return byId.get(prev);
}
