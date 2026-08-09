import { AppId } from "@maestro/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest, notFound } from "../errors.js";
import { visibleKnowledge } from "../knowledge-policy.js";
import { pageBody, pageOf, visibleProjects } from "./paging.js";

/** The registry and the security board describe the platform (M86 admin surface). */
export const CATALOG_ROLES = ["admin", "tech-lead"] as const;

/**
 * The reference data Studio renders around a run: which applications exist,
 * what the analyst knows, what the scanners found and what the gateway spent.
 */
export async function studioCatalogRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const preHandler = authGuard(deps);

  /**
   * The Application Registry (M100). Readable by any session: an engineer has
   * to be able to see which application their ticket was matched to, and the
   * record carries no secret — the repo path is already in every PR link.
   */
  app.get("/studio/apps", { preHandler }, async (request, reply) => {
    const page = await deps.read.apps.list(pageOf(request.query));
    return reply.code(200).send(pageBody(page));
  });

  app.get("/studio/apps/:appId", { preHandler }, async (request, reply) => {
    const appId = appIdParam(request.params);
    const record = await deps.read.apps.get(appId);
    if (record === null) throw notFound("unknown_app", { appId });
    return reply.code(200).send(record);
  });

  /**
   * The repo card (M100) — the module summary the analyst judges cross-app
   * impact from. `null` when one was never generated, which is a real state:
   * an application onboarded this morning has no card yet, and inventing an
   * empty one would let an analysis claim it checked something it did not.
   */
  app.get("/studio/apps/:appId/repo-card", { preHandler }, async (request, reply) => {
    const appId = appIdParam(request.params);
    if ((await deps.read.apps.get(appId)) === null) throw notFound("unknown_app", { appId });
    const card = await deps.read.apps.repoCard(appId);
    if (card === null) throw notFound("no_repo_card", { appId });
    return reply.code(200).send(card);
  });

  /**
   * Knowledge search (M18/M63). The data-class filter is applied HERE, on the
   * way out, and it is fail-closed: a document the index could not classify is
   * `gizli` and a session without the clearance never sees it. The count of
   * what was withheld is returned so the screen can say "3 results hidden"
   * rather than quietly showing a short list.
   */
  app.get("/studio/knowledge", { preHandler }, async (request, reply) => {
    const query = KnowledgeQuery.safeParse(request.query);
    if (!query.success) throw badRequest("invalid_query");

    const page = await deps.read.knowledge.search({
      ...pageOf(request.query),
      text: query.data.q,
      appId: query.data.appId ?? null,
    });

    const filtered = visibleKnowledge(page.items, sessionOf(request));
    return reply.code(200).send({
      items: filtered.visible,
      nextCursor: page.nextCursor,
      withheld: filtered.withheld,
    });
  });

  /**
   * Security findings (M27). Scoped per project like the runs they belong to:
   * a finding names a file and a line in somebody's repository, which is not
   * something every account with a login should be able to enumerate.
   */
  app.get("/studio/scans", { preHandler }, async (request, reply) => {
    const page = await deps.read.scans.list({
      ...pageOf(request.query),
      projectKeys: visibleProjects(sessionOf(request)),
    });
    return reply.code(200).send(pageBody(page));
  });

  /**
   * The gateway call log (M16). Platform-wide spend is an operator's view; the
   * per-run slice lives on `/studio/runs/:ticket/cost`, where the project check
   * applies. Without that split, a `runId` query parameter here would be a way
   * to read a stranger's consumption.
   */
  app.get(
    "/studio/cost",
    { preHandler: [preHandler, requireAnyRole(...CATALOG_ROLES)] },
    async (request, reply) => {
      const page = await deps.read.cost.calls({ ...pageOf(request.query), runId: null });
      return reply.code(200).send(pageBody(page));
    },
  );

  /**
   * Who holds which role (M8/M86). Admin-only and deliberately thin: the
   * directory is the source of truth, this is a window onto it, and it returns
   * no password material because `UserDirectory` is the only thing that has
   * ever seen any.
   */
  app.get(
    "/studio/users/:username",
    { preHandler: [preHandler, requireAnyRole("admin")] },
    async (request, reply) => {
      const parsed = z
        .object({ username: z.string().trim().min(1).max(128) })
        .safeParse(request.params);
      if (!parsed.success) throw badRequest("invalid_username");

      const user = await deps.users.find(parsed.data.username);
      if (user === null) throw notFound("unknown_user");
      return reply.code(200).send({
        username: user.username,
        userId: user.userId,
        roles: user.roles,
        groups: user.groups,
        active: user.active,
      });
    },
  );
}

const KnowledgeQuery = z.object({
  q: z.string().trim().min(1).max(512),
  appId: z.string().trim().min(1).max(64).optional(),
});

function appIdParam(params: unknown): string {
  const parsed = z.object({ appId: AppId }).safeParse(params);
  if (!parsed.success) throw badRequest("invalid_app_id");
  return parsed.data.appId;
}
