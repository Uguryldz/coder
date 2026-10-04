import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { DashScreen, STUCK_AFTER_MS, isStuck } from "../src/screens/Dash.tsx";
import { toRunRow } from "../src/screens/shared/runs.ts";
import { renderScreen, stubFetch } from "./harness.tsx";

/**
 * Two tiles the Panel gained:
 *
 *  · "Kapıda" is now a way INTO the list — clicking it slices the jobs below
 *    to the gate chip through `?status=gate`, so the URL carries the slice.
 *  · "Takılı": runs whose status is `running` but whose `updatedAt` has not
 *    moved for 30 minutes. A dead worker and a hung service both look like
 *    this, and both looked healthy under "Çalışıyor" before.
 *
 * Timestamps are computed from `Date.now()` rather than fixed: "30 minutes
 * ago" is a fact about now, and a frozen fixture would silently become stuck
 * (or unstuck) as the calendar moves.
 */

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

/** The wire row typed for `toRunRow`; the fixture is deliberately loose JSON. */
type WireRow = Parameters<typeof toRunRow>[0];

function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function run(ticketKey: string, status: string | null, updatedAt: string, startedAt = agoIso(2 * 60 * 60_000)) {
  return {
    ticketKey,
    title: `${ticketKey} konusu`,
    appId: "odeme-servisi",
    mode: "ai_assist",
    risk: "orta",
    dataClass: "dahili",
    parentTicketKey: null,
    childTicketKeys: [],
    reporter: "mehmet.demir@ugurbank",
    assignee: null,
    prId: null,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    updatedAt,
    archivedAt: null,
    state:
      status === null
        ? null
        : { runId: `run-${ticketKey}`, ticketKey, step: "6a", status, risk: "orta", startedAt, updatedAt },
  };
}

/** StartGuide's reads, so the Panel renders whole. */
const GUIDE_ROUTES = [
  { path: "/onboarding/jira-connections", body: { connections: [] } },
  { path: "/onboarding/scm-connections", body: { connections: [] } },
  { path: "/routing", body: { projects: [], rules: [], policy: null } },
  { path: "/studio/listening-rules", body: { rules: [] } },
];

describe("dash — stuck runs", () => {
  it("isStuck: running + updatedAt older than the threshold; never for another status or a missing time", () => {
    const now = Date.now();
    const old = new Date(now - STUCK_AFTER_MS - 1000).toISOString();
    const fresh = new Date(now - 5 * 60_000).toISOString();
    const row = (...args: Parameters<typeof run>) => toRunRow(run(...args) as unknown as WireRow);
    expect(isStuck(row("A-1", "running", old), now)).toBe(true);
    expect(isStuck(row("A-2", "running", fresh), now)).toBe(false);
    expect(isStuck(row("A-3", "gate", old), now)).toBe(false);
    expect(isStuck(row("A-4", "running", "not-a-date"), now)).toBe(false);
  });

  it("counts the runs that have not moved for 30 minutes and lists them, oldest first", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/runs",
        body: {
          items: [
            run("OPS-1", "running", agoIso(45 * 60_000)),
            run("OPS-2", "running", agoIso(90 * 60_000)),
            run("OPS-3", "running", agoIso(5 * 60_000)),
            run("OPS-4", "gate", agoIso(3 * 60 * 60_000)),
          ],
          nextCursor: null,
        },
      },
      ...GUIDE_ROUTES,
    ]);
    renderScreen(<DashScreen />, { fetchImpl });

    const tile = (await screen.findByText("Takılı")).closest("section")!;
    expect(within(tile).getByText("2")).toBeInTheDocument();

    const section = screen.getByText("Takılı koşular").closest("section")!;
    const rows = within(section).getAllByRole("button");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("OPS-2"); // 90 min: the older one first
    expect(rows[1]!.textContent).toContain("OPS-1");
    expect(rows[0]!.textContent).toMatch(/son güncelleme 1 saat önce/);
    // Fresh and gated runs are not "stuck".
    expect(within(section).queryByText(/OPS-3/)).not.toBeInTheDocument();
    expect(within(section).queryByText(/OPS-4/)).not.toBeInTheDocument();
  });

  it("shows — rather than 0 when no running run carries a usable updatedAt", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/runs",
        body: { items: [run("OPS-1", "running", "not-a-date")], nextCursor: null },
      },
      ...GUIDE_ROUTES,
    ]);
    renderScreen(<DashScreen />, { fetchImpl });

    const tile = (await screen.findByText("Takılı")).closest("section")!;
    expect(within(tile).getByText("—")).toBeInTheDocument();
    expect(within(tile).getByText("son güncelleme zamanı bilinmiyor")).toBeInTheDocument();
    expect(screen.queryByText("Takılı koşular")).not.toBeInTheDocument();
  });

  it("shows 0 when nothing is running at all", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/runs", body: { items: [run("OPS-4", "gate", agoIso(60 * 60_000))], nextCursor: null } },
      ...GUIDE_ROUTES,
    ]);
    renderScreen(<DashScreen />, { fetchImpl });
    const tile = (await screen.findByText("Takılı")).closest("section")!;
    expect(within(tile).getByText("0")).toBeInTheDocument();
  });
});

describe("dash — the gate tile opens the gate slice of the list", () => {
  it("clicking Kapıda sets ?status=gate and presses the gate chip", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/runs",
        body: {
          items: [
            run("OPS-1", "running", agoIso(60_000)),
            run("OPS-4", "gate", agoIso(60 * 60_000)),
            run("OPS-5", "gate", agoIso(2 * 60 * 60_000)),
          ],
          nextCursor: null,
        },
      },
      ...GUIDE_ROUTES,
    ]);
    renderScreen(
      <>
        <DashScreen />
        <LocationProbe />
      </>,
      { fetchImpl, initialEntries: ["/dash"] },
    );

    const tile = (await screen.findByText("Kapıda")).closest("section")!;
    expect(within(tile).getByText("2")).toBeInTheDocument();
    // The whole tile is the button; its title names where it goes.
    const button = within(tile).getByRole("button", { name: /Kapıda 2/ });
    expect(button.getAttribute("title")).toBe("Kapıda bekleyen ticket'ları listele");
    await userEvent.click(button);

    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/dash?status=gate"));
    const chip = screen.getByRole("button", { name: /Kapıda \(2\)/ });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    // The list is sliced: the running run is gone from the table.
    await waitFor(() => expect(screen.queryByText("OPS-1 konusu")).not.toBeInTheDocument());
    expect(screen.getByText("OPS-4 konusu")).toBeInTheDocument();
  });

  it("a pasted ?status=gate link opens the list already sliced", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/runs",
        body: {
          items: [run("OPS-1", "running", agoIso(60_000)), run("OPS-4", "gate", agoIso(60 * 60_000))],
          nextCursor: null,
        },
      },
      ...GUIDE_ROUTES,
    ]);
    renderScreen(<DashScreen />, { fetchImpl, initialEntries: ["/dash?status=gate"] });

    const chip = await screen.findByRole("button", { name: /Kapıda \(1\)/ });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("OPS-4 konusu")).toBeInTheDocument();
    expect(screen.queryByText("OPS-1 konusu")).not.toBeInTheDocument();
  });
});
