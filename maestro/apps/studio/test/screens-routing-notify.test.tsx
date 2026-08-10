import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NotifyScreen } from "../src/screens/Notify.tsx";
import { RoutingScreen } from "../src/screens/Routing.tsx";
import { renderScreen, stubFetch, VIEWER } from "./harness.tsx";

function routingBody(whenOnpremMissing: string, gizliOutcome: string) {
  return {
    path: "/routing",
    body: {
      projects: [
        {
          projectKey: "UGURPAY",
          trigger: "auto",
          apps: ["ugurpay-core"],
          noteKey: "routing.note.active_auto",
        },
      ],
      rules: [
        { ruleId: "dataclass:acik", conditionKey: "routing.policy.condition.data_class", conditionParams: { dataClass: "acik" }, backend: "api", model: "api", outcome: "ok" },
        { ruleId: "dataclass:dahili", conditionKey: "routing.policy.condition.data_class", conditionParams: { dataClass: "dahili" }, backend: "api", model: "api", outcome: "ok" },
        { ruleId: "dataclass:gizli", conditionKey: "routing.policy.condition.data_class", conditionParams: { dataClass: "gizli" }, backend: "onprem", model: "onprem", outcome: "ok" },
        { ruleId: "dataclass:onprem_missing", conditionKey: "routing.policy.condition.backend_unavailable", conditionParams: { backend: "onprem" }, backend: "onprem", model: "onprem", outcome: gizliOutcome },
      ],
      // The RAW stored policy — the only safe thing to edit against. The rules
      // above are lossy (`degraded` hides `degrade_ai_assist` vs `masked_cloud`).
      policy: {
        backendByClass: { acik: "api", dahili: "api", gizli: "onprem" },
        whenOnpremMissing,
      },
    },
  };
}

// Default fixture: a lenient degraded fallback.
const ROUTING_BODY = routingBody("degrade_ai_assist", "degraded");

const APPS_BODY = {
  path: "/studio/apps",
  body: {
    items: [
      {
        appId: "ugurpay-core",
        displayName: "UgurPay Core",
        adoProject: "Payments",
        adoRepo: "ugurpay-core",
        platform: "linux-node",
        jiraComponent: null,
        maestroYamlPresent: true,
        createdVia: "onboarding",
      },
    ],
    nextCursor: null,
  },
};

describe("routing screen", () => {
  it("shows the Application Registry target of a match (M100)", async () => {
    const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY]);
    renderScreen(<RoutingScreen />, { fetchImpl });

    expect(await screen.findByText("UgurPay Core")).toBeInTheDocument();
    expect(screen.getByText("Payments/_git/ugurpay-core")).toBeInTheDocument();
  });

  it("hides the guarded policy editor from a non-admin", async () => {
    const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY]);
    renderScreen(<RoutingScreen />, { fetchImpl, session: VIEWER });

    await screen.findByText("UgurPay Core");
    expect(screen.queryByRole("button", { name: /Politikayı düzenle/ })).not.toBeInTheDocument();
  });

  it("saves the data-class policy as a four-eyes proposal, not a live change", async () => {
    const { fetchImpl, calls } = stubFetch([
      ROUTING_BODY,
      APPS_BODY,
      {
        path: "/routing",
        method: "PUT",
        body: { status: "pending", pending: { key: "dataclass.policy", scopeRef: null, value: {}, proposedBy: "someone.else", at: "2026-08-10T00:00:00.000Z" } },
      },
    ]);
    renderScreen(<RoutingScreen />, { fetchImpl });

    await screen.findByText("UgurPay Core");
    await userEvent.click(screen.getByRole("button", { name: /Politikayı düzenle/ }));
    // The guarded warning is shown before the operator types.
    expect(await screen.findByText(/korumalıdır/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Onaya gönder/ }));

    const put = calls.find((call) => call.method === "PUT" && call.url.endsWith("/routing"));
    expect(put).toBeDefined();
    const payload = put!.body as { policy: { backendByClass: Record<string, string> } };
    // Backends are prefilled from the raw stored policy.
    expect(payload.policy.backendByClass.gizli).toBe("onprem");
    // A guarded save reports pending, never "applied".
    expect(await screen.findByText(/dört-göz onayına gönderildi/)).toBeInTheDocument();
  });

  /**
   * The security regression the verifier caught: a no-op save must NOT downgrade
   * the stored fallback. With `whenOnpremMissing: "block"` in the database, an
   * admin who opens the editor (to change something else, or nothing) and never
   * touches the fallback dropdown must PUT `block` back — not the lenient
   * `degrade_ai_assist` the screen once hardcoded, which would silently let a
   * `gizli` ticket that should be BLOCKED fall through to AI-assist, past two
   * approvers who only ever saw the fabricated value.
   */
  it("round-trips the stored fallback verbatim on an untouched save (no silent downgrade)", async () => {
    const { fetchImpl, calls } = stubFetch([
      routingBody("block", "blocked"),
      APPS_BODY,
      {
        path: "/routing",
        method: "PUT",
        body: { status: "applied", change: {} },
      },
    ]);
    renderScreen(<RoutingScreen />, { fetchImpl });

    await screen.findByText("UgurPay Core");
    await userEvent.click(screen.getByRole("button", { name: /Politikayı düzenle/ }));
    await screen.findByText(/korumalıdır/);
    // Deliberately touch NOTHING, then save.
    await userEvent.click(screen.getByRole("button", { name: /Onaya gönder/ }));

    const put = calls.find((call) => call.method === "PUT" && call.url.endsWith("/routing"));
    expect(put).toBeDefined();
    const payload = put!.body as { policy: { whenOnpremMissing: string } };
    expect(payload.policy.whenOnpremMissing).toBe("block");
    expect(payload.policy.whenOnpremMissing).not.toBe("degrade_ai_assist");
  });
});

const NOTIFY_BODY = {
  path: "/notify",
  body: {
    ladder: [{ afterHours: 24, channels: ["jira"], kind: "notify" }],
    delegations: [],
    waiting: [],
    routing: { default: ["teams"], byEvent: {} },
    ladderRaw: {
      steps: [{ id: "reminder-24h", afterHours: 24, channel: "jira", event: "gate_reminder", action: "notify" }],
      businessHoursOnly: false,
      calendar: {},
    },
  },
};

describe("notify screen editing", () => {
  it("edits a threshold and PUTs the same step id so open gates do not re-escalate", async () => {
    const { fetchImpl, calls } = stubFetch([
      NOTIFY_BODY,
      { path: "/notify", method: "PUT", body: { results: [{ status: "applied", change: {} }] } },
    ]);
    renderScreen(<NotifyScreen />, { fetchImpl });

    await userEvent.click(await screen.findByRole("button", { name: /Merdiveni düzenle/ }));
    const dialog = await screen.findByRole("dialog");
    const hours = within(dialog).getByRole("spinbutton");
    await userEvent.clear(hours);
    await userEvent.type(hours, "48");
    await userEvent.click(within(dialog).getByRole("button", { name: "Kaydet" }));

    const put = calls.find((call) => call.method === "PUT" && call.url.endsWith("/notify"));
    expect(put).toBeDefined();
    const payload = put!.body as { ladder: { steps: { id: string; afterHours: number }[] } };
    expect(payload.ladder.steps[0]?.id).toBe("reminder-24h");
    expect(payload.ladder.steps[0]?.afterHours).toBe(48);
  });

  it("keeps the edit button from a non-admin", async () => {
    const { fetchImpl } = stubFetch([NOTIFY_BODY]);
    renderScreen(<NotifyScreen />, { fetchImpl, session: VIEWER });

    await screen.findByText(/otomatik ret yok/);
    expect(screen.queryByRole("button", { name: /Merdiveni düzenle/ })).not.toBeInTheDocument();
  });
});
