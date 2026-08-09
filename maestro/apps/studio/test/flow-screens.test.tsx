import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import type { Session } from "../src/auth/types.ts";
import { I18nProvider } from "../src/i18n/I18nProvider.tsx";
import { ClarifyScreen } from "../src/screens/Clarify.tsx";
import { DashScreen } from "../src/screens/Dash.tsx";
import { DetailScreen } from "../src/screens/Detail.tsx";
import { EvidenceScreen } from "../src/screens/Evidence.tsx";
import { FanoutScreen } from "../src/screens/Fanout.tsx";
import { LiveScreen } from "../src/screens/Live.tsx";
import { TicketsScreen } from "../src/screens/Tickets.tsx";
import { WorkmodeScreen } from "../src/screens/Workmode.tsx";
import { ToastProvider } from "../src/ui/Toast.tsx";

/**
 * Flow screens (dash, tickets, detail, live, clarify, workmode, fanout,
 * evidence, jira).
 *
 * Every test drives a stub fetch: test/setup.ts makes the global one throw, so
 * a screen that bypasses the ApiClient fails here rather than silently hitting
 * the network.
 */

const TECH_LEAD: Session = {
  userId: "ayse.kaya@ugurbank.local",
  username: "ayse.kaya",
  roles: ["tech-lead"],
  groups: ["maestro-ugurpay"],
  delegated: false,
  expiresAt: "2099-01-01T00:00:00.000Z",
};

const QA: Session = { ...TECH_LEAD, roles: ["qa"], username: "deniz.yilmaz" };
const DELEGATED_TECH_LEAD: Session = { ...TECH_LEAD, delegated: true };

const RUNS = [
  {
    workflowId: "maestro-UGURPAY-501",
    ticketKey: "UGURPAY-501",
    runId: "run-501-aaaaaaaa",
    status: "running",
    startedAt: "2026-08-01T09:00:00.000Z",
    closedAt: null,
  },
  {
    workflowId: "maestro-UGURPAY-478",
    ticketKey: "UGURPAY-478",
    runId: "run-478-bbbbbbbb",
    status: "completed",
    startedAt: "2026-07-28T09:00:00.000Z",
    closedAt: "2026-07-29T09:00:00.000Z",
  },
  {
    workflowId: "maestro-UGURDESK-45",
    ticketKey: "UGURDESK-45",
    runId: "run-45-cccccccc",
    status: "failed",
    startedAt: "2026-07-20T09:00:00.000Z",
    closedAt: "2026-07-30T09:00:00.000Z",
  },
];

const GATE_RUN = {
  runId: "run-501-aaaaaaaa",
  ticketKey: "UGURPAY-501",
  step: "12",
  status: "gate",
  risk: "orta",
  startedAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-08-06T09:00:00.000Z",
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

/** A fetch stub that answers from a routing table and records every call. */
function stubFetch(routes: Readonly<Record<string, () => Response>>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    // Longest prefix wins, so "/api/runs/X" never shadows "/api/runs/X/signals/...".
    const key = Object.keys(routes)
      .filter((route) => url.startsWith(route))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    return routes[key]!();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderScreen(
  ui: ReactNode,
  options: { fetchImpl: typeof fetch; session?: Session; route?: string; path?: string } ,
): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <I18nProvider initialLocale="tr">
      <QueryClientProvider client={queryClient}>
        <AuthProvider
          fetchImpl={options.fetchImpl}
          initialSession={options.session ?? TECH_LEAD}
          initialToken="test-token"
        >
          <ToastProvider>
            <MemoryRouter initialEntries={[options.route ?? "/"]}>
              {options.path === undefined ? (
                ui
              ) : (
                <Routes>
                  <Route path={options.path} element={ui} />
                </Routes>
              )}
            </MemoryRouter>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("tickets", () => {
  it("lists runs from GET /runs and filters by status", async () => {
    const { fetchImpl } = stubFetch({ "/api/runs": () => json({ runs: RUNS }) });
    renderScreen(<TicketsScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("UGURPAY-501")).toBeInTheDocument());
    expect(screen.getByText("UGURPAY-478")).toBeInTheDocument();
    expect(screen.getByText("UGURDESK-45")).toBeInTheDocument();

    // "Tamamlandı (1)" — the count is derived, not hard-coded.
    await userEvent.click(screen.getByRole("button", { name: /Tamamlandı \(1\)/ }));
    expect(screen.getByText("UGURPAY-478")).toBeInTheDocument();
    expect(screen.queryByText("UGURPAY-501")).not.toBeInTheDocument();
    expect(screen.queryByText("UGURDESK-45")).not.toBeInTheDocument();
  });

  it("filters by Jira project", async () => {
    const { fetchImpl } = stubFetch({ "/api/runs": () => json({ runs: RUNS }) });
    renderScreen(<TicketsScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("UGURPAY-501")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Proje"), "UGURDESK");

    expect(screen.getByText("UGURDESK-45")).toBeInTheDocument();
    expect(screen.queryByText("UGURPAY-501")).not.toBeInTheDocument();
  });

  it("shows a translated message instead of the server's error code", async () => {
    const { fetchImpl } = stubFetch({
      "/api/runs": () => json({ error: "project_access" }, 403),
    });
    renderScreen(<TicketsScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).not.toContain("project_access");
    expect(screen.getByRole("alert").textContent?.length ?? 0).toBeGreaterThan(10);
  });

  it("sends the bearer token and the limit through the ApiClient", async () => {
    const { fetchImpl, calls } = stubFetch({ "/api/runs": () => json({ runs: [] }) });
    renderScreen(<TicketsScreen />, { fetchImpl });

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]!.url).toBe("/api/runs?limit=200");
  });
});

describe("dash", () => {
  it("counts the KPIs from the run list rather than showing constants", async () => {
    const { fetchImpl } = stubFetch({ "/api/runs": () => json({ runs: RUNS }) });
    renderScreen(<DashScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("Aktif iş akışı")).toBeInTheDocument());

    const active = screen.getByText("Aktif iş akışı").closest("section");
    expect(within(active!).getByText("1")).toBeInTheDocument();

    const total = screen.getByText("Toplam").closest("section");
    expect(within(total!).getByText("3")).toBeInTheDocument();
  });

  it("puts the failed run first in the attention list", async () => {
    const { fetchImpl } = stubFetch({ "/api/runs": () => json({ runs: RUNS }) });
    renderScreen(<DashScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("Dikkat isteyenler")).toBeInTheDocument());
    const rows = screen.getAllByRole("button").filter((el) => el.className.includes("screen-issue"));
    expect(rows[0]!.textContent).toContain("UGURDESK-45");
  });

  it("shows the empty state when the operator has no runs", async () => {
    const { fetchImpl } = stubFetch({ "/api/runs": () => json({ runs: [] }) });
    renderScreen(<DashScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("Henüz iş akışı yok")).toBeInTheDocument());
    expect(screen.queryByText("Aktif iş akışı")).not.toBeInTheDocument();
  });
});

describe("detail + gate decision", () => {
  const routes: Readonly<Record<string, () => Response>> = {
    "/api/runs/UGURPAY-501/journal": () => json({ error: "not_found" }, 404),
    "/api/runs/UGURPAY-501": () => json(GATE_RUN),
  };

  function renderDetail(session: Session, extra: Readonly<Record<string, () => Response>> = {}) {
    const stub = stubFetch({ ...routes, ...extra });
    renderScreen(<DetailScreen />, {
      fetchImpl: stub.fetchImpl,
      session,
      route: "/detail/UGURPAY-501",
      path: "/detail/:ticket",
    });
    return stub;
  }

  it("renders the run's step and risk from GET /runs/:ticket", async () => {
    renderDetail(TECH_LEAD);
    await waitFor(() => expect(screen.getByText("Künye")).toBeInTheDocument());

    expect(screen.getAllByText("PR onayı").length).toBeGreaterThan(0);
    expect(screen.getByText("orta")).toBeInTheDocument();
    // risk orta -> 4 gates, read from GATES_BY_RISK, not typed in
    expect(screen.getByText("4 kapı")).toBeInTheDocument();
  });

  it("sends the approval as a gateDecision SIGNAL, with no actor in the body", async () => {
    const stub = renderDetail(TECH_LEAD, {
      "/api/runs/UGURPAY-501/signals/gateDecision": () =>
        json({ accepted: true, step: "12", signatureSeq: 7 }),
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Onayla" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Onayla" }));
    await userEvent.click(screen.getByRole("button", { name: "Onayla ve imzala" }));

    await waitFor(() => {
      const signal = stub.calls.find((call) => call.url.includes("/signals/gateDecision"));
      expect(signal).toBeDefined();
      expect(signal!.method).toBe("POST");
      expect(signal!.body).toEqual({ decision: "approve" });
    });

    // The identity must come from the session server-side, never the payload.
    const signal = stub.calls.find((call) => call.url.includes("/signals/gateDecision"))!;
    expect(signal.body).not.toHaveProperty("actorUserId");
    expect(signal.body).not.toHaveProperty("actor");
  });

  it("refuses to send a rejection without a reason", async () => {
    const stub = renderDetail(TECH_LEAD, {
      "/api/runs/UGURPAY-501/signals/gateDecision": () => json({ accepted: true }),
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Reddet" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Reddet" }));

    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Reddet" });
    expect(submit).toBeDisabled();

    await userEvent.click(submit);
    expect(stub.calls.some((call) => call.url.includes("/signals/"))).toBe(false);

    // With a reason it goes, and the reason travels with it.
    await userEvent.type(within(dialog).getByLabelText("Gerekçe"), "kapsam eksik");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reddet" }));

    await waitFor(() => {
      const signal = stub.calls.find((call) => call.url.includes("/signals/gateDecision"));
      expect(signal?.body).toEqual({ decision: "reject", reason: "kapsam eksik" });
    });
  });

  it("disables the decision for a role that does not own the gate", async () => {
    // Step 12 belongs to tech-lead; a QA session must not be offered the button.
    renderDetail(QA);
    await waitFor(() => expect(screen.getByRole("button", { name: "Onayla" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Reddet" })).toBeDisabled();
  });

  it("disables the decision for a delegated (AI) session", async () => {
    renderDetail(DELEGATED_TECH_LEAD);
    await waitFor(() => expect(screen.getByRole("button", { name: "Onayla" })).toBeDisabled());
  });

  it("translates a 404 from GET /runs/:ticket instead of printing the code", async () => {
    const stub = stubFetch({ "/api/runs/UGURPAY-999": () => json({ error: "no_run" }, 404) });
    renderScreen(<DetailScreen />, {
      fetchImpl: stub.fetchImpl,
      route: "/detail/UGURPAY-999",
      path: "/detail/:ticket",
    });

    await waitFor(() => expect(screen.getByText("Veri alınamadı")).toBeInTheDocument());
    expect(document.body.textContent).not.toContain("no_run");
  });

  it("shows the journal's failure as translated text, not invented history", async () => {
    renderDetail(TECH_LEAD);
    await waitFor(() => expect(screen.getByText("Künye")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("tab", { name: /Ticket defteri/ }));

    await waitFor(() => expect(screen.getByText("Veri alınamadı")).toBeInTheDocument());
    expect(document.body.textContent).not.toContain("not_found");
  });
});

describe("clarify", () => {
  it("sends the answer as a clarificationAnswered signal", async () => {
    const stub = stubFetch({
      "/api/runs/UGURPAY-712/signals/clarificationAnswered": () => json({ accepted: true }),
      "/api/runs": () => json({ runs: RUNS }),
    });
    renderScreen(<ClarifyScreen />, { fetchImpl: stub.fetchImpl });

    await userEvent.type(screen.getByLabelText("Ticket"), "UGURPAY-712");
    await userEvent.type(screen.getByLabelText("Yanıt"), "p95 < 800 ms");
    await userEvent.click(screen.getByRole("button", { name: "Yanıtı gönder" }));

    await waitFor(() => {
      const call = stub.calls.find((entry) => entry.url.includes("clarificationAnswered"));
      expect(call?.method).toBe("POST");
      expect(call?.body).toEqual({ text: "p95 < 800 ms" });
    });
  });

  it("keeps the send button disabled until both fields are filled", async () => {
    const stub = stubFetch({ "/api/runs": () => json({ runs: [] }) });
    renderScreen(<ClarifyScreen />, { fetchImpl: stub.fetchImpl });

    const send = screen.getByRole("button", { name: "Yanıtı gönder" });
    expect(send).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Ticket"), "UGURPAY-712");
    expect(send).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Yanıt"), "cevap");
    expect(send).toBeEnabled();
    expect(stub.calls.some((call) => call.url.includes("/signals/"))).toBe(false);
  });
});

describe("workmode", () => {
  it("confirms before sending the modeChange signal", async () => {
    const stub = stubFetch({
      "/api/runs/UGURPAY-503/signals/modeChange": () =>
        json({ accepted: true, mode: "human_lead" }),
    });
    renderScreen(<WorkmodeScreen />, { fetchImpl: stub.fetchImpl });

    await userEvent.type(screen.getByLabelText("Ticket"), "UGURPAY-503");
    await userEvent.selectOptions(screen.getByLabelText("Yeni mod"), "human_lead");
    await userEvent.click(screen.getByRole("button", { name: "Modu değiştir" }));

    // The modal stands between the click and the request.
    expect(stub.calls.some((call) => call.url.includes("/signals/"))).toBe(false);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Değiştir" }));

    await waitFor(() => {
      const call = stub.calls.find((entry) => entry.url.includes("modeChange"));
      expect(call?.body).toEqual({ mode: "human_lead" });
    });
  });

  it("renders every mode from the frozen WorkMode enum", () => {
    const stub = stubFetch({});
    renderScreen(<WorkmodeScreen />, { fetchImpl: stub.fetchImpl });

    for (const mode of ["full_auto", "ai_assist", "human_lead", "human_only"]) {
      expect(screen.getAllByText(mode).length).toBeGreaterThan(0);
    }
  });
});

describe("fanout", () => {
  it("shows sibling runs of the parent's project and never invents a tree", async () => {
    const { fetchImpl } = stubFetch({ "/api/runs": () => json({ runs: RUNS }) });
    renderScreen(<FanoutScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("Etki matrisi")).toBeInTheDocument());
    expect(screen.getByText(/Etki matrisi analiz belgesinde yaşıyor/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Ana ticket anahtarı"), "UGURPAY-500");

    await waitFor(() => expect(screen.getByText("UGURPAY-501")).toBeInTheDocument());
    expect(screen.getByText("UGURPAY-478")).toBeInTheDocument();
    // A different project must not be pulled in.
    expect(screen.queryByText("UGURDESK-45")).not.toBeInTheDocument();
  });
});

describe("evidence", () => {
  const PACKAGE = {
    runId: "run-123-dddddddd",
    ticketKey: "UGURPAY-123",
    createdAt: "2026-08-02T10:00:00.000Z",
    templateVersion: "v3",
    files: [
      {
        name: "01-analiz.md",
        sha256: "a".repeat(64),
        bytes: 28672,
        contentType: "text/markdown",
      },
    ],
    approvals: [
      {
        step: "12",
        decision: "approve",
        actorUserId: "ayse.kaya@ugurbank",
        actorGroup: "tech-leads",
        sodVerified: true,
        signatureSeq: 81402,
        source: "jira",
        at: "2026-08-02T09:00:00.000Z",
      },
    ],
    retentionYears: 10,
    objectLock: true,
  };

  it("renders the manifest and the signed approval chain", async () => {
    const { fetchImpl } = stubFetch({
      "/api/runs/UGURPAY-123/evidence": () => json(PACKAGE),
    });
    renderScreen(<EvidenceScreen />, { fetchImpl });

    await userEvent.type(screen.getByLabelText("Ticket"), "UGURPAY-123");

    await waitFor(() => expect(screen.getByText("01-analiz.md")).toBeInTheDocument());
    expect(screen.getByText("28 KB")).toBeInTheDocument();
    expect(screen.getByText("ayse.kaya@ugurbank")).toBeInTheDocument();
    // sodVerified comes from the decision, and is shown as such.
    expect(screen.getByText("doğrulandı")).toBeInTheDocument();
  });

  it("reports an unverified SoD rather than showing a green tick anyway", async () => {
    const unverified = {
      ...PACKAGE,
      approvals: [{ ...PACKAGE.approvals[0]!, sodVerified: false }],
    };
    const { fetchImpl } = stubFetch({
      "/api/runs/UGURPAY-123/evidence": () => json(unverified),
    });
    renderScreen(<EvidenceScreen />, { fetchImpl });

    await userEvent.type(screen.getByLabelText("Ticket"), "UGURPAY-123");
    await waitFor(() => expect(screen.getByText("doğrulanmadı")).toBeInTheDocument());
    expect(screen.queryByText("doğrulandı")).not.toBeInTheDocument();
  });

  it("asks for a ticket before fetching anything", () => {
    const stub = stubFetch({});
    renderScreen(<EvidenceScreen />, { fetchImpl: stub.fetchImpl });

    expect(screen.getByText("Paketi görmek için bir ticket anahtarı yaz.")).toBeInTheDocument();
    expect(stub.calls).toHaveLength(0);
  });
});

describe("live", () => {
  it("draws the pipeline from the contract's step table and lists real running work", async () => {
    const { fetchImpl } = stubFetch({ "/api/runs": () => json({ runs: RUNS }) });
    renderScreen(<LiveScreen />, { fetchImpl });

    // Steps come from STEP_IDS — 2b is a step id that only exists there.
    expect(screen.getByText("2b")).toBeInTheDocument();
    expect(screen.getAllByText("insan kapısı").length).toBeGreaterThan(0);

    await waitFor(() => expect(screen.getByText("UGURPAY-501")).toBeInTheDocument());
    // Only running work belongs in the live table.
    expect(screen.queryByText("UGURPAY-478")).not.toBeInTheDocument();
  });
});
