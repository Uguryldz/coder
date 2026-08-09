import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import type { ResolvedDeps, SessionRecord } from "../deps.js";
import { forbidden, unauthenticated } from "../errors.js";
import { bearerToken, isExpired } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by {@link authGuard}; absent means the route was never guarded. */
    maestroSession?: SessionRecord;
  }
}

/**
 * Bearer-token authentication for every REST route (M7: no unauthenticated
 * data path exists — v1's second, auth-free CRUD surface is what this closes).
 * The webhook routes are not exempt: they authenticate with the delivery
 * signature instead, through the port.
 */
export function authGuard(deps: ResolvedDeps): preHandlerHookHandler {
  return async (request) => {
    const token = bearerToken(request.headers.authorization);
    if (token === null) throw unauthenticated();

    const session = await deps.sessions.get(token);
    if (session === null) throw unauthenticated();

    if (isExpired(session, deps.clock.now())) {
      await deps.sessions.delete(session.token);
      throw unauthenticated("session_expired");
    }
    request.maestroSession = session;
  };
}

/** Roles gate the admin surface (M86: Studio is open, but not every screen is). */
export function requireRole(role: string): preHandlerHookHandler {
  return async (request) => {
    const session = sessionOf(request);
    if (!session.roles.includes(role)) throw forbidden("role_required", { role });
  };
}

/**
 * The session a guarded handler runs under. Throwing rather than returning
 * `undefined` keeps a route that forgot its guard from reading as anonymous.
 */
export function sessionOf(request: FastifyRequest): SessionRecord {
  const session = request.maestroSession;
  if (session === undefined) throw unauthenticated();
  return session;
}
