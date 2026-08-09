import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";
import { RequireSession } from "../auth/RequireSession.tsx";
import { Shell } from "../shell/Shell.tsx";
import { SCREENS } from "./screens.ts";
import { SCREEN_COMPONENTS } from "./screen-components.ts";
import { LoginScreen } from "../screens/Login.tsx";
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
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/dash" replace />} />
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
