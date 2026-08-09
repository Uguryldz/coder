import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authGuard, sessionOf } from "../auth/guard.js";
import { issueSession, MAX_SESSIONS_PER_USER } from "../auth/sessions.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest, unauthenticated } from "../errors.js";

const LoginBody = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

/**
 * Session issuance (M8). The token is a bearer credential with an absolute
 * eight-hour life; it does not slide, and nothing here reveals whether a
 * failed login was a wrong password or an unknown account.
 */
export async function authRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  app.post("/auth/login", async (request, reply) => {
    const body = LoginBody.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_login_body");

    const user = await deps.identity.authenticate(body.data.username, body.data.password);
    if (user === null) throw unauthenticated("invalid_credentials");

    const session = issueSession(user, { clock: deps.clock, ttlMs: deps.config.sessionTtlMs });
    await evictOldestSessions(deps, user.userId);
    await deps.sessions.create(session);

    return reply.code(200).send({
      token: session.token,
      expiresAt: session.expiresAt,
      user: {
        userId: session.userId,
        username: session.username,
        roles: session.roles,
        groups: session.groups,
      },
    });
  });

  /**
   * Logging out ends the ACCOUNT's sessions, not just this tab's. Someone who
   * logs out because "something looked wrong" means all of it, and a stolen
   * token will never log itself out (M8).
   */
  app.post("/auth/logout", { preHandler: authGuard(deps) }, async (request, reply) => {
    await deps.sessions.deleteByUser(sessionOf(request).userId);
    return reply.code(204).send();
  });

  app.get("/auth/session", { preHandler: authGuard(deps) }, async (request, reply) => {
    const session = sessionOf(request);
    return reply.code(200).send({
      userId: session.userId,
      username: session.username,
      roles: session.roles,
      groups: session.groups,
      delegated: session.delegated,
      expiresAt: session.expiresAt,
    });
  });
}

/**
 * Make room for the session about to be issued. Evicting the OLDEST rather
 * than refusing the newest keeps the cap from becoming a lockout: a user whose
 * quota is full of forgotten tokens can always still log in.
 */
async function evictOldestSessions(deps: ResolvedDeps, userId: string): Promise<void> {
  const live = await deps.sessions.listByUser(userId);
  const excess = live.length - (MAX_SESSIONS_PER_USER - 1);
  if (excess <= 0) return;

  const oldestFirst = [...live].sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt));
  for (const stale of oldestFirst.slice(0, excess)) {
    await deps.sessions.delete(stale.token);
  }
}
