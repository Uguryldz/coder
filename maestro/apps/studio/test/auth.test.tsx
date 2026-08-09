import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../src/app/routes.tsx";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import type { Session } from "../src/auth/types.ts";
import { hasAnyRole, hasRole, sessionFromLogin } from "../src/auth/types.ts";
import { I18nProvider } from "../src/i18n/I18nProvider.tsx";
import { ToastProvider } from "../src/ui/Toast.tsx";

const SESSION: Session = {
  userId: "ayse.kaya@ugurbank.local",
  username: "ayse.kaya",
  roles: ["tech-lead"],
  groups: ["maestro-ugurpay"],
  delegated: false,
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function renderApp(options: {
  route?: string;
  session?: Session | null;
  token?: string | null;
  fetchImpl?: typeof fetch;
}): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const fetchImpl =
    options.fetchImpl ??
    ((async () => new Response(JSON.stringify({ level: "off" }), { status: 200 })) as typeof fetch);

  render(
    <I18nProvider initialLocale="tr">
      <QueryClientProvider client={queryClient}>
        <AuthProvider
          fetchImpl={fetchImpl}
          initialSession={options.session ?? null}
          initialToken={options.token ?? null}
        >
          <ToastProvider>
            <MemoryRouter initialEntries={[options.route ?? "/dash"]}>
              <AppRoutes />
            </MemoryRouter>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("session redirect", () => {
  it("sends an anonymous visitor to the login screen", async () => {
    renderApp({ route: "/dash", session: null });
    expect(await screen.findByLabelText("Kullanıcı adı")).toBeInTheDocument();
  });

  it("guards a deep link too, not just the root", async () => {
    renderApp({ route: "/params", session: null });
    expect(await screen.findByLabelText("Parola")).toBeInTheDocument();
  });

  it("lets an authenticated user reach a screen", async () => {
    renderApp({ route: "/dash", session: SESSION, token: "tok" });
    expect(await screen.findAllByText("Panel")).not.toHaveLength(0);
  });

  it("shows a translated 404 for an unknown in-shell route", async () => {
    renderApp({ route: "/nope", session: SESSION, token: "tok" });
    expect(await screen.findByText("Sayfa bulunamadı")).toBeInTheDocument();
  });
});

describe("login", () => {
  it("stores the session and shows the app after a successful sign-in", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return new Response(
          JSON.stringify({
            token: "new-token",
            expiresAt: SESSION.expiresAt,
            user: {
              userId: SESSION.userId,
              username: SESSION.username,
              roles: SESSION.roles,
              groups: SESSION.groups,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ level: "off" }), { status: 200 });
    });

    renderApp({ route: "/login", session: null, fetchImpl: fetchImpl as unknown as typeof fetch });

    await userEvent.type(await screen.findByLabelText("Kullanıcı adı"), "ayse.kaya");
    await userEvent.type(screen.getByLabelText("Parola"), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Giriş yap" }));

    await waitFor(() => {
      expect(screen.queryByLabelText("Parola")).not.toBeInTheDocument();
    });
  });

  it("shows a translated message, never the raw code, on bad credentials", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "invalid_credentials" }), { status: 401 }),
    );

    renderApp({ route: "/login", session: null, fetchImpl: fetchImpl as unknown as typeof fetch });

    await userEvent.type(await screen.findByLabelText("Kullanıcı adı"), "ayse.kaya");
    await userEvent.type(screen.getByLabelText("Parola"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Giriş yap" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Kullanıcı adı veya parola hatalı.");
    expect(alert).not.toHaveTextContent("invalid_credentials");
  });
});

describe("role helpers", () => {
  it("reads roles off the session", () => {
    expect(hasRole(SESSION, "tech-lead")).toBe(true);
    expect(hasRole(SESSION, "admin")).toBe(false);
    expect(hasRole(null, "admin")).toBe(false);
  });

  it("treats an empty requirement as open to everyone", () => {
    expect(hasAnyRole(SESSION, [])).toBe(true);
    expect(hasAnyRole(null, [])).toBe(true);
    expect(hasAnyRole(SESSION, ["admin", "tech-lead"])).toBe(true);
    expect(hasAnyRole(SESSION, ["admin"])).toBe(false);
  });

  it("normalises the login shape into a session", () => {
    const normalised = sessionFromLogin({
      token: "t",
      expiresAt: "2099-01-01T00:00:00.000Z",
      user: { userId: "u@corp", username: "u", roles: ["admin"], groups: [] },
    });
    expect(normalised.username).toBe("u");
    expect(normalised.delegated).toBe(false);
  });
});

describe("navigation role filtering", () => {
  it("hides an admin-only entry from a tech-lead (usability, not security)", async () => {
    renderApp({ route: "/dash", session: SESSION, token: "tok" });
    await screen.findAllByText("Panel");
    // params is admin+tech-lead: visible. users is admin-only: hidden.
    expect(screen.getByText("Parametreler (DB)")).toBeInTheDocument();
    expect(screen.queryByText("Kullanıcılar & roller")).not.toBeInTheDocument();
  });

  it("shows admin entries to an admin", async () => {
    renderApp({
      route: "/dash",
      session: { ...SESSION, roles: ["admin"] },
      token: "tok",
    });
    await screen.findAllByText("Panel");
    expect(screen.getByText("Kullanıcılar & roller")).toBeInTheDocument();
  });

  it("still routes to a hidden screen when typed directly, because the BFF is the real guard", async () => {
    renderApp({ route: "/users", session: SESSION, token: "tok" });
    // Reachable in the client; authorisation happens server-side on fetch.
    expect(await screen.findAllByText("Kullanıcılar & roller")).not.toHaveLength(0);
  });
});
