import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import type { Session } from "../src/auth/types.ts";
import { I18nProvider } from "../src/i18n/I18nProvider.tsx";
import { ToastProvider } from "../src/ui/Toast.tsx";
import { ListeningScreen } from "../src/screens/Listening.tsx";

/**
 * Listening rules screen — status/issuetype → flow-type CRUD.
 *
 * The behaviours under test: the table renders the rules the endpoint returns,
 * the add-form is visible only to an admin (a viewer sees the read-only table),
 * and creating a rule POSTs the typed fields.
 */

const ADMIN: Session = {
  userId: "ayse@x",
  username: "ayse",
  roles: ["admin"],
  groups: [],
  expiresAt: "2099-01-01T00:00:00.000Z",
  delegated: false,
  mustChangePassword: false,
};
const VIEWER: Session = { ...ADMIN, username: "can", roles: ["developer"] };

const SEED = {
  ruleId: "lr_1",
  projectKey: "OPS",
  assigneeAccountId: "712020:bot",
  matchKind: "issuetype",
  matchValue: "Hata",
  flowType: "duzeltme",
  priority: 100,
  enabled: true,
};

function renderScreen(session: Session): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <I18nProvider>
          <ToastProvider>
            <AuthProvider initialSession={session}>
              <ListeningScreen />
            </AuthProvider>
          </ToastProvider>
        </I18nProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** A fetch stub that records POSTs and answers GET with the seeded rule. */
function stubFetch(rules: object[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("/studio/listening-rules") && method === "GET") {
      return Response.json({ rules });
    }
    if (u.includes("/studio/listening-rules") && method === "POST") {
      return Response.json({ rule: { ...SEED, ruleId: "lr_new" } }, { status: 201 });
    }
    if (u.includes("/studio/pilot/listening")) return Response.json({ ok: true });
    // The assignee field pre-fills from a tested Jira connection's botAccountId.
    if (u.includes("/onboarding/jira-connections")) {
      return Response.json({ connections: [] });
    }
    // The project dropdown reads bound projects from /routing.
    if (u.includes("/routing")) {
      return Response.json({ projects: [{ projectKey: "OPS", trigger: "auto", apps: [], noteKey: "" }], rules: [], policy: null });
    }
    return Response.json({}, { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("ListeningScreen", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders the rules from the endpoint", async () => {
    stubFetch([SEED]);
    renderScreen(ADMIN);
    expect(await screen.findByText("Hata")).toBeTruthy();
    // The flow type is localized — it appears in the row badge (and also in the
    // admin form's dropdown), so assert at least one occurrence.
    expect(screen.getAllByText("Düzeltme").length).toBeGreaterThan(0);
  });

  it("shows the add-form to an admin", async () => {
    stubFetch([]);
    renderScreen(ADMIN);
    expect(await screen.findByText("Yeni kural ekle")).toBeTruthy();
  });

  it("hides the add-form from a viewer", async () => {
    stubFetch([SEED]);
    renderScreen(VIEWER);
    // The table still renders (read), but the form card does not.
    await waitFor(() => expect(screen.getByText("Hata")).toBeTruthy());
    expect(screen.queryByText("Yeni kural ekle")).toBeNull();
  });

  it("POSTs the typed fields when a rule is added", async () => {
    const fn = stubFetch([]);
    renderScreen(ADMIN);
    await screen.findByText("Yeni kural ekle");

    // Project is now a dropdown of bound projects, filled from /routing. Wait for
    // the option to arrive, then pick OPS. The two text fields (bot user + value)
    // are the first two textboxes once the project is a Select.
    await screen.findByRole("option", { name: "OPS" });
    await userEvent.selectOptions(screen.getByLabelText("Proje"), "OPS");
    const inputs = screen.getAllByRole("textbox");
    await userEvent.type(inputs[0]!, "712020:bot");
    await userEvent.type(inputs[1]!, "Hata");
    await userEvent.click(screen.getByRole("button", { name: "Kural ekle" }));

    await waitFor(() => {
      const posted = fn.mock.calls.find(
        (c) => String(c[0]).includes("/studio/listening-rules") && (c[1] as RequestInit)?.method === "POST",
      );
      expect(posted).toBeTruthy();
      const body = JSON.parse((posted![1] as RequestInit).body as string);
      expect(body.projectKey).toBe("OPS"); // picked from the dropdown, not typed
      expect(body.matchValue).toBe("Hata");
      expect(body.assigneeAccountId).toBe("712020:bot");
    });
  });
});
