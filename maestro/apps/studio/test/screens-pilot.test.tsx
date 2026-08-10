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

  it("shows a Başlat button to an operator and starts the flow with the ticket key", async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: "/studio/pilot/state", body: IDLE_STATE },
      { path: "/studio/pilot/start", method: "POST", status: 202, body: { ok: true } },
    ]);
    renderScreen(<PilotScreen />, { session: ADMIN, fetchImpl });

    const startButtons = await screen.findAllByRole("button", { name: /Başlat/ });
    expect(startButtons.length).toBeGreaterThan(0);
    await userEvent.click(startButtons[0]!);

    await waitFor(() => {
      const post = calls.find((c) => c.url.endsWith("/studio/pilot/start") && c.method === "POST");
      expect(post).toBeDefined();
      expect(post?.body).toEqual({ ticketKey: "OPS-42" });
    });
  });

  it("hides the start button from a viewer (role-gated in the UI, enforced at the BFF)", async () => {
    const { fetchImpl, calls } = stubFetch([{ path: "/studio/pilot/state", body: IDLE_STATE }]);
    renderScreen(<PilotScreen />, { session: VIEWER, fetchImpl });

    // The discovered list renders, but no start button exists for a viewer.
    expect(await screen.findByText("OPS-42")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Başlat/ })).not.toBeInTheDocument();
    // And the viewer never issued a start call.
    expect(calls.some((c) => c.url.endsWith("/studio/pilot/start"))).toBe(false);
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
