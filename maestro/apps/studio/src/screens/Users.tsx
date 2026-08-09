import type { ReactNode } from "react";
import { Placeholder } from "../app/Placeholder.tsx";

/**
 * Screen: users
 *
 * STUB — owned by the screen agent assigned to "users".
 * Replace the body of this component with the real screen. Do not edit
 * src/app/screens.ts (the route table) or src/app/routes.tsx; your route,
 * title key and sidebar entry are already registered there.
 *
 * Rules that still apply to the finished screen:
 *  - every visible string comes from the catalog via useT() — no literals;
 *  - build from src/ui primitives (see src/ui/README.md);
 *  - fetch through useApi() + TanStack Query, never bare fetch();
 *  - keep this file under 300 lines, split into src/screens/users/ if it grows.
 */
export function UsersScreen(): ReactNode {
  return <Placeholder id="users" />;
}
