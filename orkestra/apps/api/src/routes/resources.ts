/**
 * Thin Prisma-backed resource routes powering the Agent Studio's
 * Refine data provider. Intentionally minimal — hand-off to the DB layer.
 */
import { verifyChain } from "@orkestra/audit";
import { createLogger } from "@orkestra/config";
import { getDb } from "@orkestra/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

const log = createLogger("resources");

const allowedResources = new Set([
  "agentVariant",
  "promptVersion",
  "knowledgeFile",
  "variantKnowledgeLink",
  "routingRule",
  "goldenTicket",
  "evaluation",
  "workflowRun",
  "stepExecution",
  "humanDecision",
  "auditLog",
  "user",
  "setting",
  "piiMaskingConfig",
  "knowledgeFeedback",
]);

const ListQuery = z.object({
  _start: z.coerce.number().optional(),
  _end: z.coerce.number().optional(),
  _sort: z.string().optional(),
  _order: z.enum(["asc", "desc"]).optional(),
});

function getModel(db: ReturnType<typeof getDb>, resource: string): any {
  if (!allowedResources.has(resource)) throw new Error("unknown resource");
  // @ts-expect-error dynamic model lookup
  return db[resource];
}

export async function resourceRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/resources/:resource",
    async (
      req: FastifyRequest<{ Params: { resource: string }; Querystring: Record<string, string> }>,
      reply,
    ) => {
      try {
        const db = getDb();
        const model = getModel(db, req.params.resource);
        const q = ListQuery.parse(req.query);
        const take = q._end && q._start ? q._end - q._start : 50;
        const skip = q._start ?? 0;
        const orderBy = q._sort ? { [q._sort]: q._order ?? "asc" } : { id: "desc" };
        const [rows, total] = await Promise.all([
          model.findMany({ take, skip, orderBy }),
          model.count(),
        ]);
        reply.header("X-Total-Count", String(total));
        return rows;
      } catch (e) {
        log.error({ err: String(e), resource: req.params.resource }, "list error");
        return reply.status(400).send({ error: String(e) });
      }
    },
  );

  app.get(
    "/resources/:resource/:id",
    async (req: FastifyRequest<{ Params: { resource: string; id: string } }>, reply) => {
      try {
        const db = getDb();
        const model = getModel(db, req.params.resource);
        const row = await model.findUnique({ where: { id: req.params.id } });
        if (!row) return reply.status(404).send({ error: "not found" });
        return row;
      } catch (e) {
        return reply.status(400).send({ error: String(e) });
      }
    },
  );

  app.post(
    "/resources/:resource",
    async (req: FastifyRequest<{ Params: { resource: string }; Body: unknown }>, reply) => {
      try {
        const db = getDb();
        const model = getModel(db, req.params.resource);
        const created = await model.create({ data: req.body as object });
        return created;
      } catch (e) {
        return reply.status(400).send({ error: String(e) });
      }
    },
  );

  app.patch(
    "/resources/:resource/:id",
    async (
      req: FastifyRequest<{ Params: { resource: string; id: string }; Body: unknown }>,
      reply,
    ) => {
      try {
        const db = getDb();
        const model = getModel(db, req.params.resource);
        const updated = await model.update({
          where: { id: req.params.id },
          data: req.body as object,
        });
        return updated;
      } catch (e) {
        return reply.status(400).send({ error: String(e) });
      }
    },
  );

  app.delete(
    "/resources/:resource/:id",
    async (req: FastifyRequest<{ Params: { resource: string; id: string } }>, reply) => {
      try {
        const db = getDb();
        const model = getModel(db, req.params.resource);
        await model.delete({ where: { id: req.params.id } });
        return { ok: true };
      } catch (e) {
        return reply.status(400).send({ error: String(e) });
      }
    },
  );

  // Specialized endpoints
  app.get("/audit/verify", async () => {
    const tamperedId = await verifyChain();
    return { ok: tamperedId === null, tamperedFirstId: tamperedId?.toString() ?? null };
  });

  app.get(
    "/workflows/:id/detail",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      try {
        const db = getDb();
        const run = await db.workflowRun.findUnique({
          where: { id: req.params.id },
          include: {
            steps: { orderBy: { startedAt: "asc" } },
            decisions: { orderBy: { decidedAt: "asc" } },
            artifacts: true,
            auditEntries: { orderBy: { id: "asc" } },
          },
        });
        if (!run) return reply.status(404).send({ error: "not found" });
        return run;
      } catch (e) {
        return reply.status(500).send({ error: String(e) });
      }
    },
  );
}
