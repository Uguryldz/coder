import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authGuard, sessionOf } from "../auth/guard.js";
import { issueSession } from "../auth/sessions.js";
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

  app.post("/auth/logout", { preHandler: authGuard(deps) }, async (request, reply) => {
    await deps.sessions.delete(sessionOf(request).token);
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
