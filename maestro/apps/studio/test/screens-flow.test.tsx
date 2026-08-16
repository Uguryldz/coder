import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import { I18nProvider } from "../src/i18n/I18nProvider.tsx";
import { ToastProvider } from "../src/ui/Toast.tsx";
import { FlowScreen } from "../src/screens/Flow.tsx";
import {
  activeNodeId,
  edgeAnchors,
  layoutFlow,
  normalizeCategory,
  presentCategories,
  MARGIN,
  NODE_WIDTH,
  NODE_HEIGHT,
  COLUMN_GAP,
  ROW_GAP,
  type FlowGraph,
  type FlowStatus,
} from "../src/screens/flow/layout.ts";
import { ADMIN } from "./harness.tsx";

/**
 * Flow screen (Dalga D) — the live OPS Jira workflow drawn as SVG.
 *
 * The geometry is a PURE function (`layoutFlow`), so the deterministic tests
 * assert its numbers directly rather than sniffing pixels out of the DOM. The
 * fixtures use the BFF's REAL wire shape (apps/bff/src/jira-workflow-model.ts):
 * `projectKey`, a category LABEL ("To Do"/"In Progress"/"Done"), transitions
 * carrying an `id` and a NULLABLE `fromStatusId`, plus `edgesComplete` /
 * `sampledFrom`. A test that used an invented shape would pass here and break
 * against the server.
 */

/** The live OPS statuses, exactly as verified against uyildiz.atlassian.net. */
const OPS_STATUSES: readonly FlowStatus[] = [
  { id: "10000", name: "Yapılacaklar", category: "To Do" },
  { id: "10001", name: "Devam Ediyor", category: "In Progress" },
  { id: "10002", name: "İNCELEMEDE", category: "In Progress" },
  { id: "10003", name: "Tamam", category: "Done" },
];

const OPS_GRAPH: FlowGraph = {
  statuses: OPS_STATUSES,
  transitions: [
    { id: "11", name: "Başlat", fromStatusId: "10000", toStatusId: "10001" },
    { id: "21", name: "İncelemeye gönder", fromStatusId: "10001", toStatusId: "10002" },
    { id: "31", name: "Tamamla", fromStatusId: "10002", toStatusId: "10003" },
    // A re-open: In-Review back to In-Progress — a backward, same-column edge.
    { id: "41", name: "Geri gönder", fromStatusId: "10002", toStatusId: "10001" },
  ],
};

describe("flow category normalization (pure)", () => {
  it("maps Jira's label AND its machine key to a column bucket", () => {
    expect(normalizeCategory("To Do")).toBe("todo");
    expect(normalizeCategory("new")).toBe("todo");
    expect(normalizeCategory("In Progress")).toBe("inprogress");
    expect(normalizeCategory("indeterminate")).toBe("inprogress");
    expect(normalizeCategory("Done")).toBe("done");
    // An unreported or unrecognised category is a visible "other", not dropped.
    expect(normalizeCategory("")).toBe("other");
    expect(normalizeCategory("Beklemede")).toBe("other");
  });
});

describe("flow layout (pure)", () => {
  it("orders columns To Do -> In Progress -> Done and drops empty categories", () => {
    expect(presentCategories(OPS_STATUSES)).toEqual(["todo", "inprogress", "done"]);
    // No In-Progress status -> the middle column vanishes, it is not left blank.
    const noProgress = OPS_STATUSES.filter((s) => s.category !== "In Progress");
    expect(presentCategories(noProgress)).toEqual(["todo", "done"]);
  });

  it("places nodes deterministically by category column and stacked row", () => {
    const layout = layoutFlow(OPS_GRAPH);

    const todo = layout.nodes.find((n) => n.id === "10000")!;
    const prog = layout.nodes.find((n) => n.id === "10001")!;
    const review = layout.nodes.find((n) => n.id === "10002")!;
    const done = layout.nodes.find((n) => n.id === "10003")!;

    // Column 0 / row 0.
    expect([todo.column, todo.row]).toEqual([0, 0]);
    expect(todo.x).toBe(MARGIN);
    expect(todo.y).toBe(MARGIN);

    // Two in-progress statuses stack in column 1, rows 0 and 1, in server order.
    expect([prog.column, prog.row]).toEqual([1, 0]);
    expect([review.column, review.row]).toEqual([1, 1]);
    expect(prog.x).toBe(MARGIN + (NODE_WIDTH + COLUMN_GAP));
    expect(review.y).toBe(MARGIN + (NODE_HEIGHT + ROW_GAP));

    // Done is column 2.
    expect(done.column).toBe(2);

    // Centres are precomputed and consistent.
    expect(todo.cx).toBe(todo.x + NODE_WIDTH / 2);
    expect(todo.cy).toBe(todo.y + NODE_HEIGHT / 2);

    // Same input -> identical output, twice.
    expect(layoutFlow(OPS_GRAPH)).toEqual(layout);
  });

  it("emits one edge per transition whose target exists, and skips dangling ones", () => {
    const layout = layoutFlow(OPS_GRAPH);
    expect(layout.edges).toHaveLength(4);

    // A transition into a status the endpoint never listed is not drawn.
    const withDangling = layoutFlow({
      ...OPS_GRAPH,
      transitions: [
        ...OPS_GRAPH.transitions,
        { id: "99", name: "Ghost", fromStatusId: "10003", toStatusId: "99999" },
      ],
    });
    expect(withDangling.edges).toHaveLength(4);
  });

  it("expands a global (fromStatusId: null) transition into an edge from every other node", () => {
    // A global "İptal" to Done: reachable from all three non-Done statuses.
    const withGlobal = layoutFlow({
      ...OPS_GRAPH,
      transitions: [{ id: "51", name: "İptal", fromStatusId: null, toStatusId: "10003" }],
    });
    // 4 statuses, one is the target -> 3 edges, each marked global.
    expect(withGlobal.edges).toHaveLength(3);
    expect(withGlobal.edges.every((e) => e.global && e.toId === "10003")).toBe(true);
    expect(new Set(withGlobal.edges.map((e) => e.fromId))).toEqual(
      new Set(["10000", "10001", "10002"]),
    );
  });

  it("routes a forward edge right-face to left-face and a same-column edge vertically", () => {
    const layout = layoutFlow(OPS_GRAPH);
    const nodeById = new Map(layout.nodes.map((n) => [n.id, n]));

    // Forward: 10000 -> 10001 leaves the source's RIGHT and enters target LEFT.
    const forward = edgeAnchors(nodeById.get("10000")!, nodeById.get("10001")!);
    expect(forward.x1).toBe(nodeById.get("10000")!.x + NODE_WIDTH);
    expect(forward.x2).toBe(nodeById.get("10001")!.x);

    // Backward (10002 -> 10001, same column, lower row -> upper): vertical.
    const back = edgeAnchors(nodeById.get("10002")!, nodeById.get("10001")!);
    expect(back.y2).toBe(nodeById.get("10001")!.y + NODE_HEIGHT);
  });
});

describe("flow active-node selection (pure)", () => {
  const layout = layoutFlow(OPS_GRAPH);

  it("matches a live status to a node by statusId", () => {
    expect(activeNodeId(layout, "10002")).toBe("10002");
  });

  it("highlights nothing for an absent, null or unknown status", () => {
    expect(activeNodeId(layout, null)).toBeNull();
    expect(activeNodeId(layout, undefined)).toBeNull();
    expect(activeNodeId(layout, "")).toBeNull();
    // A status id the workflow never drew must not light an unrelated node.
    expect(activeNodeId(layout, "77777")).toBeNull();
  });
});

/** A fetch stub that answers a routing table and records calls. */
function stubFetch(routes: Readonly<Record<string, (url: string) => Response>>): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes)
      .filter((route) => url.split("?")[0]!.endsWith(route))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    return routes[key]!(url);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderFlow(fetchImpl: typeof fetch): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <I18nProvider initialLocale="tr">
      <QueryClientProvider client={queryClient}>
        <AuthProvider fetchImpl={fetchImpl} initialSession={ADMIN} initialToken="test-token">
          <ToastProvider>
            <MemoryRouter initialEntries={["/flow"]}>
              <FlowScreen />
            </MemoryRouter>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

/** The BFF's `JiraWorkflowGraphView`, verbatim shape. */
const WORKFLOW_BODY = {
  projectKey: "OPS",
  statuses: OPS_STATUSES,
  transitions: OPS_GRAPH.transitions,
  edgesComplete: false,
  sampledFrom: ["OPS-1", "OPS-2", "OPS-7"],
};

describe("flow screen", () => {
  it("draws every OPS status as a node from GET /studio/jira-workflow", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/studio/jira-workflow": () => json(WORKFLOW_BODY),
    });
    renderFlow(fetchImpl);

    // The node labels are drawn inside the SVG figure. "Yapılacaklar" also
    // appears as a column header + legend chip, so scope to the SVG text nodes.
    const fig = await screen.findByRole("img");
    const labels = [...fig.querySelectorAll(".flow-node-label")].map((n) => n.textContent);
    expect(labels).toEqual(["Yapılacaklar", "Devam Ediyor", "İNCELEMEDE", "Tamam"]);

    // The figure is one accessible image with a title.
    expect(fig).toHaveAttribute("aria-labelledby");

    // It asked the workflow endpoint with the project query.
    expect(calls.some((u) => u.includes("/studio/jira-workflow?project=OPS"))).toBe(true);

    // edgesComplete:false is surfaced honestly, with the sample count.
    expect(screen.getByText(/3 ticket örneğinden/)).toBeInTheDocument();
  });

  it("highlights the node for the status the operator selects, by statusId", async () => {
    const { fetchImpl } = stubFetch({
      "/studio/jira-workflow": () => json(WORKFLOW_BODY),
    });
    renderFlow(fetchImpl);

    await screen.findByRole("img");

    // No highlight before a status is chosen.
    expect(document.querySelector(".flow-node--active")).toBeNull();

    // Pick "İNCELEMEDE" (statusId 10002) — the picker is fed from the real
    // statuses, so its option value is the id, never the display name.
    await userEvent.selectOptions(screen.getByLabelText("Ticket'ın statüsü"), "10002");

    await waitFor(() => {
      const active = document.querySelector(".flow-node--active");
      expect(active).not.toBeNull();
      expect(active!.textContent).toContain("İNCELEMEDE");
      // aria-current means colour is not the only signal for "hangi adımdayız".
      expect(active!.getAttribute("aria-current")).toBe("step");
    });

    // The caption (role=status) states where the ticket is, in words.
    const caption = document.querySelector('[role="status"]');
    expect(caption?.textContent).toContain("İNCELEMEDE");
    expect(caption?.textContent).toContain("buradayız");
  });

  it("shows 'not built yet' rather than an empty diagram when the endpoint 404s", async () => {
    const { fetchImpl } = stubFetch({
      // jira-workflow is unmatched -> the stub answers 404.
    });
    renderFlow(fetchImpl);

    await waitFor(() => expect(screen.getByText(/yayında değil/)).toBeInTheDocument());
    // No node boxes were drawn.
    expect(document.querySelector(".flow-node-box")).toBeNull();
  });

  it("translates a real failure instead of printing the error code", async () => {
    const { fetchImpl } = stubFetch({
      "/studio/jira-workflow": () => json({ error: "invalid_project" }, 400),
    });
    renderFlow(fetchImpl);

    await waitFor(() => expect(screen.getByText("Veri alınamadı")).toBeInTheDocument());
    expect(document.body.textContent).not.toContain("invalid_project");
  });
});
