import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashScreen } from "../src/screens/Dash.tsx";
import { StartGuide } from "../src/screens/dash/StartGuide.tsx";
import { GUIDE_DISMISSED_KEY, type SetupState } from "../src/screens/dash/setup-state.ts";
import { renderScreen, stubFetch } from "./harness.tsx";

/**
 * The start guide on the Panel.
 *
 * The rule these tests pin down is the one that was wrong: the guide appears
 * while the SETUP is incomplete, not while the run list is empty. A deployment
 * with real runs but a missing webhook is exactly the case that used to hide
 * it, so that case gets its own test.
 */

const DONE: SetupState = {
  hasConn: true,
  hasBinding: true,
  hasTrainedAgent: true,
  hasWebhook: true,
  complete: true,
  loading: false,
};

function guideProps(over: Partial<SetupState> = {}): {
  setup: SetupState;
  onDismiss: () => void;
  onWebhookAck: () => void;
} {
  return { setup: { ...DONE, ...over }, onDismiss: vi.fn(), onWebhookAck: vi.fn() };
}

/** A Panel whose runs exist but whose setup is only partly done. */
function panelRoutes(
  over: { readonly variants?: unknown[]; readonly projects?: unknown[] } = {},
): readonly { path: string; body: unknown }[] {
  return [
    // 16 runs — the old rule would have hidden the guide on this alone.
    {
      path: "/studio/runs",
      body: {
        items: Array.from({ length: 16 }, (_, i) => ({
          ticketKey: `OPS-${i}`,
          title: `iş ${i}`,
          applicationId: "maestro-pilot",
          startedAt: "2026-08-16T10:00:00.000Z",
          state: { status: "fail", step: "10", risk: "dusuk", updatedAt: "2026-08-16T10:00:00.000Z" },
        })),
        nextCursor: null,
      },
    },
    { path: "/studio/pilot/state", body: { running: false, ticketKey: null } },
    { path: "/studio/pilot/runs", body: { runs: [] } },
    { path: "/onboarding/jira-connections", body: { connections: [{ id: "jira" }] } },
    { path: "/onboarding/scm-connections", body: { connections: [] } },
    { path: "/routing", body: { projects: over.projects ?? [{ projectKey: "OPS" }] } },
    { path: "/variants", body: { variants: over.variants ?? [{ knowledgeFiles: 3 }] } },
  ];
}

beforeEach(() => {
  globalThis.localStorage?.clear();
});

describe("start guide — visibility", () => {
  it("shows on the Panel while a step is open, even with runs present", async () => {
    // Connections, binding and training are done; the WEBHOOK is not acked.
    const { fetchImpl } = stubFetch(panelRoutes());
    renderScreen(<DashScreen />, { fetchImpl });

    expect(
      await screen.findByText("Hoş geldiniz — Maestro'yu 5 adımda çalışır hale getirin"),
    ).toBeInTheDocument();
    // …and the runs really did load, so this is not an "empty dashboard".
    expect(screen.getByText("Aktif iş akışı")).toBeInTheDocument();
  });

  it("hides once every step is finished", async () => {
    globalThis.localStorage.setItem("maestro.setup.webhookAcked", "1");
    const { fetchImpl } = stubFetch(panelRoutes());
    renderScreen(<DashScreen />, { fetchImpl });

    // Wait for the setup reads to settle, then assert the guide never appears.
    expect(await screen.findByText("Aktif iş akışı")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByText("Hoş geldiniz — Maestro'yu 5 adımda çalışır hale getirin"),
      ).not.toBeInTheDocument();
    });
    // Nothing was hidden behind a "still incomplete" note either.
    expect(screen.queryByText("Kurulum hâlâ eksik; başlangıç rehberi gizlendi.")).toBeNull();
  });

  it("stays hidden across a remount once dismissed, but still admits the gap", async () => {
    const { fetchImpl } = stubFetch(panelRoutes());
    renderScreen(<DashScreen />, { fetchImpl });

    fireEvent.click(await screen.findByText("Anladım, gizle"));

    // The preference is persisted…
    expect(globalThis.localStorage.getItem(GUIDE_DISMISSED_KEY)).toBe("1");
    // …the guide is gone…
    expect(
      screen.queryByText("Hoş geldiniz — Maestro'yu 5 adımda çalışır hale getirin"),
    ).not.toBeInTheDocument();
    // …but "hide" did NOT become "done": the Panel still says setup is open.
    expect(screen.getByText("Kurulum hâlâ eksik; başlangıç rehberi gizlendi.")).toBeInTheDocument();
  });

  it("honours a previously stored dismissal on a fresh render", async () => {
    globalThis.localStorage.setItem(GUIDE_DISMISSED_KEY, "1");
    const { fetchImpl } = stubFetch(panelRoutes());
    renderScreen(<DashScreen />, { fetchImpl });

    expect(
      await screen.findByText("Kurulum hâlâ eksik; başlangıç rehberi gizlendi."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Hoş geldiniz — Maestro'yu 5 adımda çalışır hale getirin"),
    ).not.toBeInTheDocument();
  });
});

describe("start guide — steps", () => {
  it("lists five steps including the webhook and nudges the first open one", () => {
    renderScreen(
      <StartGuide {...guideProps({ hasConn: false, hasWebhook: false, complete: false })} />,
    );

    expect(screen.getByText("Bağlantıları kur")).toBeInTheDocument();
    expect(screen.getByText("Projeni bağla")).toBeInTheDocument();
    expect(screen.getByText("Jira webhook'unu kur")).toBeInTheDocument();
    expect(screen.getByText("Ajanlarını belgelerle eğit")).toBeInTheDocument();
    expect(screen.getByText("Jira'da iş aç, Panel'den izle")).toBeInTheDocument();

    const nudges = screen.getAllByText("Şimdi bunu yap →");
    expect(nudges).toHaveLength(1);
    expect(screen.getByText("Bağlantıları kur").closest("button")).toContainElement(nudges[0]!);
  });

  it("moves the nudge to the webhook when it is the only open step", () => {
    renderScreen(<StartGuide {...guideProps({ hasWebhook: false, complete: false })} />);

    const webhook = screen.getByText("Jira webhook'unu kur").closest("button")!;
    expect(webhook.className).toContain("dash-start__step--next");
    expect(screen.getByText("Bağlantıları kur").closest("button")!.className).toContain(
      "dash-start__step--done",
    );
  });

  it("remembers the webhook acknowledgement, which no endpoint can report", () => {
    const props = guideProps({ hasWebhook: false, complete: false });
    renderScreen(<StartGuide {...props} />);

    fireEvent.click(screen.getByRole("checkbox"));

    expect(globalThis.localStorage.getItem("maestro.setup.webhookAcked")).toBe("1");
    expect(props.onWebhookAck).toHaveBeenCalledWith(true);
  });
});
