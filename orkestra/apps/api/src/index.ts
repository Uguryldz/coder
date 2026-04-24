import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { createLogger, loadConfig } from "@orkestra/config";
import Fastify from "fastify";
import { artifactRoutes } from "./routes/artifacts.js";
import { bitbucketWebhookRoutes } from "./routes/bitbucket-webhook.js";
import { healthRoutes } from "./routes/health.js";
import { jiraWebhookRoutes } from "./routes/jira-webhook.js";
import { resourceRoutes } from "./routes/resources.js";

const log = createLogger("api");

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024, // 10MB — Jira comments can have big ADF
    trustProxy: true,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute",
    keyGenerator: (req) => (req.headers["x-real-ip"] as string) ?? req.ip,
  });

  app.addHook("onRequest", async (req) => {
    req.headers["x-correlation-id"] = req.headers["x-correlation-id"] ?? crypto.randomUUID();
    log.info(
      { method: req.method, url: req.url, correlationId: req.headers["x-correlation-id"] },
      "request",
    );
  });

  await healthRoutes(app);
  await jiraWebhookRoutes(app);
  await bitbucketWebhookRoutes(app);
  await resourceRoutes(app);
  await artifactRoutes(app);

  const port = cfg.API_PORT;
  const host = "0.0.0.0";
  await app.listen({ host, port });
  log.info({ port, host }, "api listening");

  const shutdown = async (sig: string): Promise<void> => {
    log.info({ sig }, "shutdown");
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  log.error({ err: String(e), stack: (e as Error).stack }, "api crashed");
  process.exit(1);
});
