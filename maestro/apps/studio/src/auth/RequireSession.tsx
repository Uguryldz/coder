import type { ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { Skeleton } from "../ui/Skeleton.tsx";
import { useAuth } from "./AuthProvider.tsx";

/**
 * Gate for every route inside the shell. No session -> /login, remembering
 * where the user was headed so the login screen can return them there.
 *
 * SECURITY NOTE — read before you rely on this.
 * This component, and the role filtering in the navigation, are a USABILITY
 * feature: they keep operators from walking into screens that would only 403.
 * They are NOT an access control. The bundle is public, roles arrive from a
 * response the client cannot vouch for, and anyone can type a URL or edit
 * memory in devtools. The real authorisation lives in the BFF, which checks
 * roles and group membership on every request (requireRole / requireAnyRole /
 * project visibility). Never move an authorisation decision into the Studio,
 * and never assume a hidden screen is an unreachable one.
 */
export function RequireSession(): ReactNode {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") return <Skeleton rows={4} />;
  if (status === "anonymous") {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}
