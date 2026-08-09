import { ParamKey } from "@maestro/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionActor } from "../actor.js";
import { authGuard, sessionOf } from "../auth/guard.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest } from "../errors.js";
import { putParam, readParams } from "../params-service.js";

const PutBody = z.object({
  value: z.unknown(),
  /** Project or application id for a scoped parameter; absent = global. */
  scopeRef: z.string().trim().min(1).nullable().optional(),
});

/**
 * Operational parameters (M71). A write on a `guarded` key does not take
 * effect on the first request: it becomes a proposal that a second, different
 * person has to confirm with the same value (four eyes, M32/M78). The response
 * says which happened — 202 for "waiting for a second approver", 200 for
 * "applied" — so Studio never has to guess whether the change is live.
 */
export async function paramRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const preHandler = authGuard(deps);

  app.get("/params", { preHandler }, async (_request, reply) => {
    return reply.code(200).send(await readParams(deps));
  });

  app.put("/params/:key", { preHandler }, async (request, reply) => {
    const key = z.object({ key: ParamKey }).safeParse(request.params);
    if (!key.success) throw badRequest("invalid_param_key");

    const body = PutBody.safeParse(request.body);
    if (!body.success || !("value" in (request.body as object))) {
      throw badRequest("invalid_param_body");
    }

    const result = await putParam(deps, {
      key: key.data.key,
      scopeRef: body.data.scopeRef ?? null,
      value: body.data.value,
      actor: sessionActor(sessionOf(request)),
    });

    return result.status === "applied"
      ? reply.code(200).send(result)
      : reply.code(202).send(result);
  });
}
