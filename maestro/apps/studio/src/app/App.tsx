import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { BrowserRouter } from "react-router";
import { AuthProvider } from "../auth/AuthProvider.tsx";
import { I18nProvider } from "../i18n/I18nProvider.tsx";
import { ToastProvider } from "../ui/Toast.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { AppRoutes } from "./routes.tsx";
import "../ui/tokens.css";

/**
 * Provider stack, outermost first:
 *   ErrorBoundary  — turns a missing catalog key into a visible panel
 *   I18n           — locale + t()
 *   QueryClient    — server cache
 *   Auth           — session + the ApiClient every screen uses
 *   Toast          — notifications
 *   Router         — routes
 * Auth sits inside QueryClient because a 401 must be able to clear cached
 * queries, and inside I18n because the login screen is translated.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        /**
         * Retry only what a retry can actually fix.
         *
         * 401 clears the session and routes to /login; retrying would spam the
         * BFF with a dead token. 403 is a settled answer about authority.
         *
         * 404 and 501 are the same kind of settled: the route does not exist in
         * this build of the BFF, and asking twice more will not bring it into
         * being. Retrying them produced three identical console errors per
         * unbuilt screen, which trains an operator to ignore the console — and
         * the console is where a REAL fault has to be visible.
         *
         * 5xx and network failures are the transient cases, and those still
         * retry.
         */
        retry: (failureCount, error) => {
          const status = (error as { status?: number }).status;
          if (status === 401 || status === 403 || status === 404 || status === 501) return false;
          return failureCount < 2;
        },
        staleTime: 15_000,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export interface AppProps {
  readonly queryClient?: QueryClient;
}

export function App({ queryClient }: AppProps = {}): ReactNode {
  const client = queryClient ?? makeQueryClient();
  return (
    <ErrorBoundary>
      <I18nProvider>
        <QueryClientProvider client={client}>
          <AuthProvider>
            <ToastProvider>
              <BrowserRouter>
                <AppRoutes />
              </BrowserRouter>
            </ToastProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ErrorBoundary>
  );
}
