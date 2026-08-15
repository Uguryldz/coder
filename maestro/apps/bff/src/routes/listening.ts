import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionActor } from "../actor.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { ListeningRuleRecord, ListeningStore } from "../listening-store.js";
import { FLOW_TYPES, MATCH_KINDS } from "../listening-store.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest, notFound } from "../errors.js";
import { assertWritable } from "../platform/propose.js";
import { unwired } from "./unwired.js";

/**
 * The listening-rules surface ("dinleme kuralları").
 *
 * An admin defines, from Studio, which tickets Maestro picks up and how it runs
 * them: "in project X, a ticket assigned to the bot whose <status|issuetype> is
 * <value> runs as <analiz|duzeltme|gelistirme>". These rows replace the
 * hard-coded `discoveryJql` (`apps/pilot/src/config.ts`), so the pilot's
 * discovery becomes configuration, not code.
 *
 * A rule is a trigger-to-flow mapping — not a model choice or a data-class
 * decision — so it is NOT four-eyes-guarded (unlike `dataclass.policy`). It is a
 * simple admin CRUD, gated the same way connections are: reads for admin +
 * tech-lead, writes for admin. Every write is audited.
 */

const READ_ROLES = ["admin", "tech-lead"] as const;
const WRITE_ROLES = ["admin"] as const;

/** The `:id` path param — a rule id is an opaque token. */
const IdParam = z.object({ ruleId: z.string().min(1).max(64) });

/**
 * The write body a route accepts. Mirrors the DB CHECK domains: `matchKind` and
 * `flowType` are closed enums here so an invalid value is a 400, not a row the
 * database rejects with a 500-shaped constraint error.
 */
/**
 * An optional agent-variant reference (Faz 3): absent, null and "" all mean
 * "the default agent" and normalise to `null`, so the DB stores one shape and
 * the pilot mirror never sees an empty string masquerading as a choice.
 */
const VariantRef = z
  .string()
  .trim()
  .max(64)
  .nullish()
  .transform((value) => (value == null || value === "" ? null : value));

const RuleBody = z.object({
  projectKey: z.string().trim().min(1).max(32),
  assigneeAccountId: z.string().trim().min(1).max(128),
  matchKind: z.enum(MATCH_KINDS as unknown as [string, ...string[]]),
  matchValue: z.string().trim().min(1).max(128),
  flowType: z.enum(FLOW_TYPES as unknown as [string, ...string[]]),
  priority: z.number().int().min(0).max(10_000).default(100),
  enabled: z.boolean().default(true),
  /** Which agent variant runs the analysis side; null → default agent. */
  analystVariantId: VariantRef,
  /** Which agent variant runs the engineering side; null → default agent. */
  engineerVariantId: VariantRef,
});

function listeningDeps(deps: ResolvedDeps): { store: ListeningStore } {
  if (deps.listening === undefined) unwired("listening");
  return { store: deps.listening };
}

export async function listeningRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const readHandler = [authGuard(deps), requireAnyRole(...READ_ROLES)];
  const writeHandler = [authGuard(deps), requireAnyRole(...WRITE_ROLES)];

  /** List every rule, ordered (projectKey, priority). */
  app.get("/studio/listening-rules", { preHandler: readHandler }, async (_request, reply) => {
    const { store } = listeningDeps(deps);
    const rules = await store.list();
    return reply.code(200).send({ rules });
  });

  /** Create a rule. A duplicate trigger (unique index) becomes a 409. */
  app.post("/studio/listening-rules", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const { store } = listeningDeps(deps);

    const body = RuleBody.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_listening_rule");

    const ruleId = `lr_${randomBytes(9).toString("hex")}`;
    const record: ListeningRuleRecord = { ruleId, ...(body.data as Omit<ListeningRuleRecord, "ruleId">) };
    try {
      await store.put(record);
    } catch (error) {
      // The unique (projectKey, assigneeAccountId, matchKind, matchValue) index
      // rejects a second rule for the same trigger — that is a 409, not a 500.
      if (isUniqueViolation(error)) throw badRequest("duplicate_listening_rule");
      throw error;
    }
    await audit(deps, request, ruleId, "created");
    return reply.code(201).send({ rule: record });
  });

  /** Replace a rule by id. */
  app.put("/studio/listening-rules/:ruleId", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const { store } = listeningDeps(deps);

    const params = IdParam.safeParse(request.params);
    if (!params.success) throw badRequest("invalid_listening_rule_id");
    const body = RuleBody.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_listening_rule");

    if ((await store.get(params.data.ruleId)) === null) throw notFound("no_such_listening_rule");

    const record: ListeningRuleRecord = {
      ruleId: params.data.ruleId,
      ...(body.data as Omit<ListeningRuleRecord, "ruleId">),
    };
    try {
      await store.put(record);
    } catch (error) {
      if (isUniqueViolation(error)) throw badRequest("duplicate_listening_rule");
      throw error;
    }
    await audit(deps, request, params.data.ruleId, "updated");
    return reply.code(200).send({ rule: record });
  });

  /** Delete a rule. */
  app.delete("/studio/listening-rules/:ruleId", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const { store } = listeningDeps(deps);

    const params = IdParam.safeParse(request.params);
    if (!params.success) throw badRequest("invalid_listening_rule_id");

    const removed = await store.remove(params.data.ruleId);
    if (!removed) throw notFound("no_such_listening_rule");
    await audit(deps, request, params.data.ruleId, "deleted");
    return reply.code(204).send();
  });
}

/** A Postgres unique-constraint violation (Prisma P2002 or a raw 23505). */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "P2002" || code === "23505";
}

/**
 * The audit row for a listening-rule change. Uses `PARAM_CHANGED` — a listening
 * rule is platform configuration in the same governance category — and carries
 * the rule id and the verb.
 */
async function audit(
  deps: ResolvedDeps,
  request: Parameters<typeof sessionOf>[0],
  ruleId: string,
  verb: string,
): Promise<void> {
  await deps.audit.append({
    actor: sessionActor(sessionOf(request)),
    action: "PARAM_CHANGED",
    subject: `listening-rule:${ruleId}`,
    at: deps.clock.now(),
    meta: { surface: "listening", verb },
  });
}
