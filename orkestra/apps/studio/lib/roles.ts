/**
 * Pure role-predicate helpers usable from client components.
 * Keep zero server-only imports (no prisma/bcrypt/next-auth server bits).
 */
export function canWrite(role: string | undefined): boolean {
  return role === "admin" || role === "team_lead";
}

export function canAdmin(role: string | undefined): boolean {
  return role === "admin";
}
