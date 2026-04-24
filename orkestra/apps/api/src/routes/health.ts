import { getDb } from "@orkestra/db";
import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health/live", async () => ({ ok: true }));

  app.get("/health/ready", async (_req, reply) => {
    const checks: Record<string, string> = {};
    try {
      await getDb().$queryRaw`SELECT 1`;
      checks.db = "ok";
    } catch (e) {
      checks.db = `error: ${String(e).slice(0, 120)}`;
    }
    const ok = !Object.values(checks).some((v) => v.startsWith("error"));
    return reply.status(ok ? 200 : 503).send({ ok, checks });
  });

  app.get("/version", async () => ({ name: "orkestra-api", version: "0.1.0" }));
}
