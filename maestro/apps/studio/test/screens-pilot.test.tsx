import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PilotScreen } from "../src/screens/Pilot.tsx";
import { ADMIN, VIEWER, renderScreen, stubFetch } from "./harness.tsx";

/**
 * The pilot screen (Dalga D) — Studio's face for the pilot's real-Jira flow.
 *
 * Every test drives a stub fetch (test/setup.ts makes the global one throw), so
 * a screen that bypassed the ApiClient would fail here. The BFF proxy is stubbed
 * with the pilot state shape it relays.
 */

const STATE = {
  runId: "run-1",
  ticketKey: "OPS-42",
  browseUrl: "https://uyildiz.atlassian.net/browse/OPS-42",
  jiraSite: "uyildiz.atlassian.net",
  approverGroup: "leads",
  running: true,
  finished: false,
  failure: null,
  awaitingGate: "3",
  docsReady: true,
  discovered: [
    { key: "OPS-42", summary: "Ödeme hatası", status: "In Progress", createdAt: null },
    { key: "OPS-43", summary: "Rapor eksik", status: "To Do", createdAt: null },
  ],
  steps: [
    { id: "1", title: "Ticket okundu", hint: "çekildi", state: "tamam", notes: [] },
    { id: "3", title: "İnsan kapısı", hint: "onay bekleniyor", state: "onay", notes: [] },
  ],
};

const IDLE_STATE = { ...STATE, ticketKey: null, running: false, awaitingGate: null, docsReady: false };

describe("PilotScreen", () => {
  it("renders the discovered maestro tickets", async () => {
    const { fetchImpl } = stubFetch([{ path: "/studio/pilot/state", body: STATE }]);
    renderScreen(<PilotScreen />, { session: ADMIN, fetchImpl });

    // OPS-42 appears in both the discovered row and the run card header.
    expect((await screen.findAllByText("OPS-42")).length).toBeGreaterThan(0);
    expect(screen.getByText("OPS-43")).toBeInTheDocument();
    expect(screen.getByText("Ödeme hatası")).toBeInTheDocument();
  });

  /**
   * WATCH-ONLY. "Canlı akış" is a window onto what Maestro is already doing —
   * the record of work happening in Jira — not a console for launching it. The
   * screen used to carry a per-ticket "Başlat" button; it is gone, and these
   * tests are what keep it gone. Work enters the platform through the listening
   * rules on a real ticket, and a second way in from here invited an operator to
   * re-run a job the engine had already taken.
   *
   * `POST /studio/pilot/start` still exists at the BFF (and keeps its own tests
   * in apps/bff/test/studio-pilot.test.ts) — this is about the screen's claim to
   * be the place you use it, not about removing the capability.
   */
  it("offers NO start control — not to an admin either", async () => {
    const { fetchImpl, calls } = stubFetch([{ path: "/studio/pilot/state", body: IDLE_STATE }]);
    renderScreen(<PilotScreen />, { session: ADMIN, fetchImpl });

    // The list is there; the button is not — for the most privileged session.
    expect(await screen.findByText("OPS-42")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Başlat/ })).not.toBeInTheDocument();

    // And nothing on the screen posts a start, whether or not it is clicked.
    await userEvent.click(screen.getByText("OPS-42"));
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith("/studio/pilot/start"))).toBe(false);
    });
  });

  it("reads the same to a viewer — the screen has no role-gated affordance left", async () => {
    const { fetchImpl, calls } = stubFetch([{ path: "/studio/pilot/state", body: IDLE_STATE }]);
    renderScreen(<PilotScreen />, { session: VIEWER, fetchImpl });

    expect(await screen.findByText("OPS-42")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Başlat/ })).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/studio/pilot/start"))).toBe(false);
  });

  it("does not leave a blank column where the button was — a watcher is told what the engine is on", async () => {
    // A screen whose only action disappears can look broken. The column now
    // carries state instead of a control: the live ticket is badged, the others
    // are marked as waiting.
    const { fetchImpl } = stubFetch([{ path: "/studio/pilot/state", body: STATE }]);
    renderScreen(<PilotScreen />, { session: ADMIN, fetchImpl });

    // OPS-42 is the running one; OPS-43 is merely discovered.
    expect((await screen.findAllByText("çalışıyor")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("bekliyor").length).toBeGreaterThan(0);
  });

  it("shows the open human gate with the /approve instruction and a real Jira link", async () => {
    const { fetchImpl } = stubFetch([{ path: "/studio/pilot/state", body: STATE }]);
    renderScreen(<PilotScreen />, { session: ADMIN, fetchImpl });

    expect(await screen.findByText(/\/approve/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Jira/ });
    expect(link).toHaveAttribute("href", STATE.browseUrl);
  });

  it("offers PDF and Word downloads once docs are ready", async () => {
    const { fetchImpl } = stubFetch([{ path: "/studio/pilot/state", body: STATE }]);
    renderScreen(<PilotScreen />, { session: ADMIN, fetchImpl });

    expect(await screen.findByRole("button", { name: /PDF/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Word/ })).toBeInTheDocument();
  });

  it("surfaces the pilot-unreachable error rather than a blank screen", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/pilot/state", status: 503, body: { error: "pilot_unreachable" } },
    ]);
    renderScreen(<PilotScreen />, { session: ADMIN, fetchImpl });

    // QueryState renders the translated code, not a blank list. The tr message
    // for pilot_unreachable names the engine being down.
    expect(await screen.findByText(/ulaşılamıyor/)).toBeInTheDocument();
  });
});
