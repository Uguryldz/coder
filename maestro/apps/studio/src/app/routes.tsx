import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";
import { RequireSession } from "../auth/RequireSession.tsx";
import { Shell } from "../shell/Shell.tsx";
import { SCREENS } from "./screens.ts";
import { SCREEN_COMPONENTS } from "./screen-components.ts";
import { LoginScreen } from "../screens/Login.tsx";
import { ChangePasswordScreen } from "../screens/ChangePassword.tsx";
import { VariantLegacyRedirect } from "../screens/Variant.tsx";
import { NotFound } from "./NotFound.tsx";

/**
 * Route wiring. Nothing here is per-screen: the tree is generated from the
 * SCREENS table, so adding a screen means adding a row there plus a component
 * in SCREEN_COMPONENTS — never editing this file.
 *
 * Shape:
 *   /login              public
 *   /                   -> /dash
 *   /<screen>           inside <Shell>, session required
 *   *                   404
 */
export function AppRoutes(): ReactNode {
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />

      <Route element={<RequireSession />}>
        {/* Outside the Shell: the first-run bootstrap blocks the whole app, so
            this screen stands alone with no sidebar until a real password is
            set. RequireSession redirects a restricted session here. */}
        <Route path="/change-password" element={<ChangePasswordScreen />} />

        <Route element={<Shell />}>
          <Route index element={<Navigate to="/dash" replace />} />
          {/* The three project-binding screens became tabs of /projects. Their
              old paths redirect to the matching tab so deep links, bookmarks and
              any lingering in-app links keep working. */}
          <Route path="onboard" element={<Navigate to="/projects?tab=onboard" replace />} />
          <Route path="routing" element={<Navigate to="/projects?tab=routing" replace />} />
          <Route path="listening" element={<Navigate to="/projects?tab=listening" replace />} />
          {/* İş akışları list merged into the Panel; keep the old path working. */}
          <Route path="tickets" element={<Navigate to="/dash" replace />} />
          {/* "Canlı akış" and its process map were the retired pilot engine's two
              faces. Their paths still resolve — a bookmark must not 404 — and
              land on the Panel, which is where live work is actually read now. */}
          <Route path="pilot" element={<Navigate to="/dash" replace />} />
          <Route path="flow" element={<Navigate to="/dash" replace />} />
          {/* LLM Gateway merged into AI usage & cost as its traffic tab. */}
          <Route path="llm" element={<Navigate to="/cost?view=traffic" replace />} />
          {/* Retired mock-gallery pages (static content, not operator tools) and
              the three "yakında" screens with no data source. Bookmarks land
              on the nearest real page instead of a 404. */}
          <Route path="live" element={<Navigate to="/dash" replace />} />
          <Route path="jira" element={<Navigate to="/help" replace />} />
          <Route path="greenfield" element={<Navigate to="/dash" replace />} />
          <Route path="cache" element={<Navigate to="/sandbox" replace />} />
          <Route path="eval" element={<Navigate to="/variants" replace />} />
          {/* Agent detail moved under /variants (sidebar stays lit); keep ?id=. */}
          <Route path="variant" element={<VariantLegacyRedirect />} />
          <Route path="security" element={<Navigate to="/audit" replace />} />
          {/* The decision ledger is the audit trail's "Kararlar" tab. */}
          <Route path="issues" element={<Navigate to="/audit?tab=decisions" replace />} />
          <Route path="runners" element={<Navigate to="/health" replace />} />
          {/* Clarify / work mode / fan-out live on the run's own detail page
              now (sidebar panels); the old ticket-less forms land on the Panel. */}
          <Route path="clarify" element={<Navigate to="/dash" replace />} />
          <Route path="workmode" element={<Navigate to="/dash" replace />} />
          <Route path="fanout" element={<Navigate to="/dash" replace />} />
          {/* The two reference pages (Jira command set, Maestro MCP) are tabs
              of Help now; the old paths land on the matching tab. */}
          <Route path="commands" element={<Navigate to="/help?cat=commands" replace />} />
          <Route path="mcp" element={<Navigate to="/help?cat=mcp" replace />} />
          {SCREENS.map((screen) => {
            const Component = SCREEN_COMPONENTS[screen.id];
            if (Component === undefined) return null;
            return <Route key={screen.id} path={screen.path} element={<Component />} />;
          })}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
