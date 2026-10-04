import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { ErrorBoundary } from "../app/ErrorBoundary.tsx";
import type { ErrorBoundaryLabels } from "../app/ErrorBoundary.tsx";
import { SCREENS } from "../app/screens.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { TopBar } from "./TopBar.tsx";
import "./Shell.css";

/**
 * The application chrome: sidebar + top bar + content well. Every authenticated
 * route renders inside this Outlet, so screens supply only their own body.
 *
 * The Outlet sits inside its OWN ErrorBoundary keyed on the path: a screen that
 * throws (a missing catalog key, a bad render) shows its red panel in the
 * content well, the menu stays usable, and picking another entry clears it.
 * The app-level boundary in App.tsx remains as the last resort for a failure
 * in the chrome itself.
 *
 * Under 820px the sidebar is a drawer: hidden by default, opened from the
 * hamburger in the top bar, closed by a navigation or the backdrop.
 */
export function Shell(): ReactNode {
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);

  // A navigation closes the drawer — the operator picked something.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  // Longest matching path wins, so /detail/:ticket beats a bare prefix.
  const current = [...SCREENS]
    .filter((screen) => {
      const base = `/${screen.path.split("/:")[0] ?? screen.path}`;
      return location.pathname === base || location.pathname.startsWith(`${base}/`);
    })
    .sort((a, b) => b.path.length - a.path.length)[0];

  const title = current === undefined ? t("app.name") : t(current.titleKey);

  const labels: ErrorBoundaryLabels = {
    title: t("error.boundary_title"),
    hint: t("error.boundary_hint"),
    back: t("error.boundary_back"),
  };

  return (
    <div className={navOpen ? "shell shell--nav-open" : "shell"}>
      <Sidebar />
      {navOpen && (
        <button
          type="button"
          className="shell__backdrop"
          aria-label={t("shell.menu_close")}
          onClick={() => setNavOpen(false)}
        />
      )}
      <div className="shell__main">
        <TopBar title={title} navOpen={navOpen} onToggleNav={() => setNavOpen((open) => !open)} />
        <main className="shell__content">
          <ErrorBoundary
            resetKey={location.pathname}
            labels={labels}
            onBack={() => {
              if (window.history.length > 1) void navigate(-1);
              else void navigate("/dash");
            }}
          >
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
