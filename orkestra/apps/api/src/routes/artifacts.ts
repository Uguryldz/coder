import { getObjectSafe } from "@orkestra/agents";
import { createLogger } from "@orkestra/config";
import type { FastifyInstance, FastifyRequest } from "fastify";

const log = createLogger("artifacts");

export async function artifactRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/artifacts",
    async (req: FastifyRequest<{ Querystring: { key?: string } }>, reply) => {
      const key = req.query.key;
      if (!key) return reply.status(400).send({ error: "key required" });

      // Güvenlik: sadece tanınmış prefix'lere izin (path traversal koruması)
      const allowedPrefixes = ["workflows/", "knowledge/", "knowledge-library/", "feedback/"];
      if (!allowedPrefixes.some((p) => key.startsWith(p))) {
        return reply.status(403).send({ error: "forbidden key prefix" });
      }

      try {
        const content = await getObjectSafe(key);
        if (content === null) {
          return reply.status(404).send({ error: "not found" });
        }
        const ctype = key.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8";
        reply.header("content-type", ctype);
        return reply.send(content);
      } catch (e) {
        log.error({ err: String(e), key }, "artifact fetch failed");
        return reply.status(500).send({ error: "fetch failed" });
      }
    },
  );
}
