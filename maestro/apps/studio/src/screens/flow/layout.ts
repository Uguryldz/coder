/**
 * Pure layout for the Jira workflow diagram (Dalga D — "hangi adımdayız").
 *
 * Studio draws this with hand-written SVG and ZERO graph libraries (bank/CSP:
 * no reactflow/xyflow/dagre may enter the bundle). So the geometry lives here,
 * as a deterministic pure function the tests pin directly: a status+transition
 * list in, node rectangles and edge line segments out. Nothing in this file
 * touches React, the DOM or the clock — same input, same coordinates, always.
 *
 * THE INPUT IS THE BFF'S OWN SHAPE. `GET /studio/jira-workflow?project=OPS`
 * (apps/bff/src/jira-workflow-model.ts) returns the live OPS project's statuses
 * and the OBSERVED transitions between them. Its `category` is Jira's own label
 * ("To Do" | "In Progress" | "Done", possibly "" or localized), and a
 * transition's `fromStatusId` is `null` for a GLOBAL transition (from any
 * status). This module normalizes both — the label into a fixed column bucket,
 * a global transition into an edge from every node — so the picture is stable.
 *
 * WHY A SEPARATE MODULE, NOT the frozen contract: `packages/contracts` owns
 * Maestro's OWN workflow (STEP_IDS / WorkflowRunStatus) and is frozen. Jira's
 * live statuses are a DIFFERENT vocabulary; mapping them onto a picture is a
 * new presentation layer, so it is a new type here rather than an edit to the
 * frozen schema — matching the BFF, which put its read model outside contracts
 * for exactly the same reason.
 *
 * LAYOUT RULE: columns follow Jira's own status-category order
 * (To Do → In Progress → Done), the left-to-right reading an operator already
 * has from the Jira board. Statuses sharing a category stack vertically in the
 * order the server sent them (stable, so the picture does not reshuffle). A
 * status whose category does not normalize lands in a trailing "other" column
 * rather than being dropped.
 */

/** The category buckets, in column order. `other` trails the known flow. */
export type FlowCategory = "todo" | "inprogress" | "done" | "other";

/** Left-to-right column order. */
export const CATEGORY_ORDER: readonly FlowCategory[] = [
  "todo",
  "inprogress",
  "done",
  "other",
];

/**
 * Normalize Jira's status-category LABEL into a column bucket.
 *
 * The BFF sends the human `statusCategory.name` ("To Do" / "In Progress" /
 * "Done"), falling back to the machine `key` ("new" / "indeterminate" / "done")
 * and to "" when Jira reports none. All three spellings and the empty case are
 * handled here so a driver or locale change moves a node to the right column
 * rather than dumping it into "other". Anything genuinely unrecognised becomes
 * `other` — a visible extra column, never a dropped node.
 */
export function normalizeCategory(raw: string): FlowCategory {
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  switch (key) {
    case "todo":
    case "new":
      return "todo";
    case "inprogress":
    case "indeterminate":
      return "inprogress";
    case "done":
    case "complete":
    case "completed":
      return "done";
    default:
      return "other";
  }
}

/** One Jira status, as the workflow endpoint sends it (BFF wire shape). */
export interface FlowStatus {
  /** Jira's status id, as a string (e.g. "10001"). Stable per site. */
  readonly id: string;
  /** The display name ("Yapılacaklar", "İNCELEMEDE", …). Shown verbatim. */
  readonly name: string;
  /** Jira's category LABEL, un-normalized ("To Do" | "In Progress" | …). */
  readonly category: string;
}

/**
 * One transition, as the endpoint sends it. `fromStatusId` is `null` for a
 * GLOBAL transition (allowed from every status), which the layout expands.
 */
export interface FlowTransition {
  readonly id: string;
  readonly name: string;
  readonly fromStatusId: string | null;
  readonly toStatusId: string;
}

/** The workflow graph the endpoint delivers. */
export interface FlowGraph {
  readonly statuses: readonly FlowStatus[];
  readonly transitions: readonly FlowTransition[];
}

/** A placed node rectangle, in SVG user units. */
export interface FlowNode {
  readonly id: string;
  readonly name: string;
  readonly category: FlowCategory;
  /** 0-based column index (position among the categories that are present). */
  readonly column: number;
  /** 0-based row within the column. */
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Centre, precomputed so edge routing and the highlight ring share it. */
  readonly cx: number;
  readonly cy: number;
}

/** A routed edge between two placed nodes' anchor points. */
export interface FlowEdge {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly name: string;
  /** True when this edge came from a `fromStatusId: null` global transition. */
  readonly global: boolean;
  /** Start point (source anchor). */
  readonly x1: number;
  readonly y1: number;
  /** End point (target anchor). */
  readonly x2: number;
  readonly y2: number;
  /** True when source and target are the same node (a self-loop). */
  readonly selfLoop: boolean;
}

/** The finished diagram: nodes, edges and the canvas it needs. */
export interface FlowLayout {
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  readonly width: number;
  readonly height: number;
  /** Column index -> category, for column headers. Only present categories. */
  readonly columns: readonly FlowCategory[];
}

/** Geometry constants. Exported so a test can assert against the source. */
export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 56;
export const COLUMN_GAP = 96;
export const ROW_GAP = 28;
export const MARGIN = 24;

/** Column pitch: a node plus the gap that follows it. */
const COLUMN_PITCH = NODE_WIDTH + COLUMN_GAP;
/** Row pitch: a node plus the gap below it. */
const ROW_PITCH = NODE_HEIGHT + ROW_GAP;

/**
 * Which categories actually appear, in {@link CATEGORY_ORDER}, deduplicated.
 *
 * A workflow with no In-Progress status must not leave an empty middle column,
 * so the present-categories list drives the column index — the To Do and Done
 * columns sit side by side and the diagram stays tight.
 */
export function presentCategories(
  statuses: readonly FlowStatus[],
): readonly FlowCategory[] {
  const seen = new Set<FlowCategory>(statuses.map((s) => normalizeCategory(s.category)));
  return CATEGORY_ORDER.filter((category) => seen.has(category));
}

/**
 * Lay out the whole graph.
 *
 * Deterministic: the node order within a column is the SERVER's order, the
 * column order is fixed, and every coordinate is a pure function of the two.
 * The tests assert the returned numbers, so this must never read the clock,
 * `Math.random`, or anything else that could make the same graph draw twice.
 */
export function layoutFlow(graph: FlowGraph): FlowLayout {
  const columns = presentCategories(graph.statuses);
  const columnIndex = new Map<FlowCategory, number>(
    columns.map((category, index) => [category, index]),
  );
  const rowCursor = new Map<FlowCategory, number>();

  const nodes: FlowNode[] = graph.statuses.map((status) => {
    const category = normalizeCategory(status.category);
    const column = columnIndex.get(category) ?? 0;
    const row = rowCursor.get(category) ?? 0;
    rowCursor.set(category, row + 1);

    const x = MARGIN + column * COLUMN_PITCH;
    const y = MARGIN + row * ROW_PITCH;
    return {
      id: status.id,
      name: status.name,
      category,
      column,
      row,
      x,
      y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      cx: x + NODE_WIDTH / 2,
      cy: y + NODE_HEIGHT / 2,
    };
  });

  const nodeById = new Map<string, FlowNode>(nodes.map((node) => [node.id, node]));
  const edges = buildEdges(graph.transitions, nodes, nodeById);

  const rows = Math.max(0, ...[...rowCursor.values()]);
  const width =
    columns.length === 0
      ? MARGIN * 2 + NODE_WIDTH
      : MARGIN * 2 + columns.length * NODE_WIDTH + (columns.length - 1) * COLUMN_GAP;
  const height = MARGIN * 2 + Math.max(1, rows) * NODE_HEIGHT + Math.max(0, rows - 1) * ROW_GAP;

  return { nodes, edges, width, height, columns };
}

/**
 * Turn transitions into placed edges.
 *
 * A `fromStatusId: null` transition is GLOBAL — allowed from every status — so
 * it becomes one edge per source node (never a line into empty space, and never
 * silently dropped). An edge whose named target was not among the placed
 * statuses is skipped: a transition pointing at a status the endpoint did not
 * list is a data gap, not something to draw. Self-targeting global edges are
 * skipped so a global "cancel" does not draw a loop on every node.
 */
function buildEdges(
  transitions: readonly FlowTransition[],
  nodes: readonly FlowNode[],
  nodeById: ReadonlyMap<string, FlowNode>,
): FlowEdge[] {
  const edges: FlowEdge[] = [];
  for (const [index, transition] of transitions.entries()) {
    const to = nodeById.get(transition.toStatusId);
    if (to === undefined) continue;

    const sources =
      transition.fromStatusId === null
        ? nodes.filter((node) => node.id !== to.id)
        : (() => {
            const from = nodeById.get(transition.fromStatusId as string);
            return from === undefined ? [] : [from];
          })();

    for (const from of sources) {
      const anchor = edgeAnchors(from, to);
      edges.push({
        id: `${from.id}->${to.id}#${transition.id}#${index}`,
        fromId: from.id,
        toId: to.id,
        name: transition.name,
        global: transition.fromStatusId === null,
        x1: anchor.x1,
        y1: anchor.y1,
        x2: anchor.x2,
        y2: anchor.y2,
        selfLoop: from.id === to.id,
      });
    }
  }
  return edges;
}

/**
 * Pick where an edge touches each node.
 *
 * Forward edges (left→right, the normal flow) leave the source's right face and
 * enter the target's left face, so arrows read like the reading direction.
 * Backward edges (a re-open moving right→left) leave the left and enter the
 * right, so they visibly go against the grain. A same-column edge routes off
 * the bottom/top faces. A self-loop returns the node's right-face point for
 * both ends; the renderer draws the loop, the anchor is only its attachment.
 */
export function edgeAnchors(
  from: FlowNode,
  to: FlowNode,
): { x1: number; y1: number; x2: number; y2: number } {
  if (from.id === to.id) {
    return { x1: from.x + from.width, y1: from.cy, x2: from.x + from.width, y2: from.cy };
  }
  if (to.column > from.column) {
    return { x1: from.x + from.width, y1: from.cy, x2: to.x, y2: to.cy };
  }
  if (to.column < from.column) {
    return { x1: from.x, y1: from.cy, x2: to.x + to.width, y2: to.cy };
  }
  // Same column: route vertically between the two stacked nodes.
  if (to.row > from.row) {
    return { x1: from.cx, y1: from.y + from.height, x2: to.cx, y2: to.y };
  }
  return { x1: from.cx, y1: from.y, x2: to.cx, y2: to.y + to.height };
}

/**
 * Resolve which node a live status sits on.
 *
 * The match is by `statusId` — the stable Jira id — NEVER by display name: the
 * OPS project renders "İNCELEMEDE" in caps and a name match is one locale or
 * one rename away from silently highlighting nothing. Returns the node id or
 * `null` when the status is not one the diagram drew (an unknown or absent
 * status must not light up an unrelated node).
 */
export function activeNodeId(
  layout: FlowLayout,
  currentStatusId: string | null | undefined,
): string | null {
  if (currentStatusId === null || currentStatusId === undefined || currentStatusId === "") {
    return null;
  }
  const hit = layout.nodes.find((node) => node.id === currentStatusId);
  return hit === undefined ? null : hit.id;
}
