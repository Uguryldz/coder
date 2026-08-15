import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashScreen } from "../src/screens/Dash.tsx";
import { renderScreen, stubFetch } from "./harness.tsx";

/**
 * The Panel's "Canlı motor işleri" section: the pilot's REAL jobs (current run
 * + finished history from /studio/pilot/runs) shown on top, with the DB-backed
 * catalog below it honestly relabelled as archive/sample records.
 */

const PILOT_STATE = {
  running: true,
  ticketKey: "OPS-9",
};

const PILOT_RUNS = {
  runs: [
    {
      runId: "r1",
      ticketKey: "OPS-7",
      browseUrl: null,
      flowType: "duzeltme",
      outcome: "tamamlandı",
      detail: null,
      stepsDone: 9,
      stepsTotal: 9,
      finishedAt: "2026-08-13T09:00:00.000Z",
    },
  ],
};

// No DB runs: the catalog is empty on a fresh live install — exactly the state
// where the old dashboard looked dead while the engine had already done work.
const ROUTES = [
  { path: "/studio/runs", body: { items: [], nextCursor: null } },
  { path: "/studio/pilot/state", body: PILOT_STATE },
  { path: "/studio/pilot/runs", body: PILOT_RUNS },
  // StartGuide's four reads (runs are empty, so it renders too).
  { path: "/onboarding/jira-connections", body: { connections: [] } },
  { path: "/onboarding/scm-connections", body: { connections: [] } },
  { path: "/routing", body: { projects: [], rules: [], policy: null } },
  { path: "/studio/listening-rules", body: { rules: [] } },
];

describe("dash — live engine jobs", () => {
  it("lists the pilot's real jobs on top: the running ticket and the finished history", async () => {
    const { fetchImpl } = stubFetch(ROUTES);
    renderScreen(<DashScreen />, { fetchImpl });

    expect(await screen.findByText("Canlı motor işleri")).toBeInTheDocument();

    // The job running RIGHT NOW, marked as such.
    expect(await screen.findByText("OPS-9")).toBeInTheDocument();
    expect(screen.getByText("şu an çalışıyor")).toBeInTheDocument();

    // A finished engine job with its outcome, step count and flow type.
    expect(await screen.findByText("OPS-7")).toBeInTheDocument();
    expect(screen.getByText("tamamlandı")).toBeInTheDocument();
    expect(screen.getByText(/9\/9 adım/)).toBeInTheDocument();

    // Rows are buttons — clicking goes to the Canlı akış screen.
    expect(screen.getByText("OPS-7").closest("button")).not.toBeNull();
  });

  it("labels the DB list honestly as archive/sample records", async () => {
    // One catalog row, so the list section renders (with none, the empty state
    // replaces it and the heading never appears).
    const DB_RUN = {
      ticketKey: "UGURPAY-1",
      title: "Ekstre filtresi",
      appId: "ugurpay",
      mode: "full_auto",
      risk: "orta",
      dataClass: "dahili",
      parentTicketKey: null,
      childTicketKeys: [],
      reporter: "ayse@corp",
      assignee: null,
      prId: null,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      startedAt: "2026-08-12T09:00:00.000Z",
      updatedAt: "2026-08-12T09:00:00.000Z",
      state: null,
    };
    const { fetchImpl } = stubFetch([
      ...ROUTES.filter((route) => route.path !== "/studio/runs"),
      { path: "/studio/runs", body: { items: [DB_RUN], nextCursor: null } },
    ]);
    renderScreen(<DashScreen />, { fetchImpl });

    expect(await screen.findByText("Arşiv / örnek kayıtlar")).toBeInTheDocument();
    expect(screen.getByText(/Veritabanındaki iş kayıtları/)).toBeInTheDocument();
  });

  it("says so when the engine has no jobs yet, instead of hiding the section", async () => {
    const { fetchImpl } = stubFetch([
      ...ROUTES.filter((route) => !route.path.includes("/pilot/")),
      { path: "/studio/pilot/state", body: { running: false, ticketKey: null } },
      { path: "/studio/pilot/runs", body: { runs: [] } },
    ]);
    renderScreen(<DashScreen />, { fetchImpl });

    expect(await screen.findByText("Motor henüz bir iş çalıştırmadı.")).toBeInTheDocument();
  });

  it("drops the section (the alert speaks instead) when the pilot is unreachable", async () => {
    const { fetchImpl } = stubFetch([
      ...ROUTES.filter((route) => !route.path.includes("/pilot/")),
      { path: "/studio/pilot/state", status: 503, body: { error: "pilot_unreachable" } },
      { path: "/studio/pilot/runs", status: 503, body: { error: "pilot_unreachable" } },
    ]);
    renderScreen(<DashScreen />, { fetchImpl });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.queryByText("Canlı motor işleri")).not.toBeInTheDocument();
  });
});
