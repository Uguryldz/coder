import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { SCREENS } from "../src/app/screens.ts";
import { SCREEN_COMPONENTS } from "../src/app/screen-components.ts";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import { I18nProvider } from "../src/i18n/I18nProvider.tsx";
import { Shell } from "../src/shell/Shell.tsx";
import { ToastProvider } from "../src/ui/Toast.tsx";
import { ADMIN, VIEWER, stubFetch } from "./harness.tsx";

/**
 * "Click every menu entry, no red screen." Every routable screen is mounted
 * inside the real Shell, as an admin and as a viewer, against a BFF that
 * answers 404 to everything. The one failure this hunts is the one that used
 * to take the whole console down: a catalog key nobody wrote
 * (MissingMessageError) — or any other render throw — on first paint. Data
 * errors are fine here (they render as translated error states); a THROW is
 * not.
 */
function mount(path: string, session: typeof ADMIN): void {
  const { fetchImpl } = stubFetch([]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nProvider initialLocale="tr">
      <QueryClientProvider client={queryClient}>
        <AuthProvider fetchImpl={fetchImpl} initialSession={session} initialToken="test-token">
          <ToastProvider>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route element={<Shell />}>
                  {SCREENS.map((screen) => {
                    const Component = SCREEN_COMPONENTS[screen.id];
                    if (Component === undefined) return null;
                    return <Route key={screen.id} path={screen.path} element={<Component />} />;
                  })}
                </Route>
              </Routes>
            </MemoryRouter>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

const PATHS = SCREENS.map((screen) => `/${screen.path.replace(":ticket", "UGURPAY-1")}`);

describe("every screen mounts inside the shell without a render throw", () => {
  for (const session of [ADMIN, VIEWER]) {
    for (const path of PATHS) {
      it(`${path} as ${session.roles[0]}`, async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        mount(path, session);
        // Let the queries settle (they all 404) so late renders are covered too.
        await waitFor(() => expect(screen.queryAllByRole("progressbar")).toHaveLength(0), { timeout: 4000 }).catch(() => undefined);
        expect(screen.queryByText(/MissingMessageError/)).not.toBeInTheDocument();
        expect(screen.queryByText("Studio bu ekranı görüntüleyemedi.")).not.toBeInTheDocument();
        expect(document.querySelector(".ui-errorpanel")).toBeNull();
        spy.mockRestore();
      });
    }
  }
});
