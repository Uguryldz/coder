import { loadEnv } from "@maestro/config";
import type { MaestroPlatform } from "@maestro/mcp-servers";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { commandDiagnosticsOf, type BffConfig, type BffDeps, type ResolvedDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { assertCatalog, defaultCatalog } from "./messages.js";
import { SESSION_TTL_MS } from "./auth/sessions.js";
import { bffPlatform } from "./platform/index.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { killSwitchRoutes } from "./routes/killswitch.js";
import { paramRoutes } from "./routes/params.js";
import { runRoutes } from "./routes/runs.js";
import { studioCatalogRoutes } from "./routes/studio-catalog.js";
import { templateRoutes } from "./routes/template.js";
import { studioOpsRoutes } from "./routes/studio-ops.js";
import { studioRunRoutes } from "./routes/studio-runs.js";
import { webhookRoutes } from "./routes/webhooks.js";

export const DEFAULT_CONFIG: Omit<BffConfig, "env"> = {
  actorDomain: "corp",
  locale: "tr",
  sessionTtlMs: SESSION_TTL_MS,
  optInLabel: "maestro",
};

/**
 * Maximum request body, chosen rather than inherited (M15). Fastify defaults to
 * 1 MB, which a real Jira delivery can exceed: a ticket with a long Turkish
 * description, a pasted stack trace and a dozen comments is not unusual, and
 * losing those deliveries would look like an outage nobody configured. 8 MB is
 * comfortably above a plausible ticket and far below anything that threatens
 * the process — the raw body is held in memory to verify its signature.
 */
export const BODY_LIMIT_BYTES = 8 * 1024 * 1024;

export function resolveDeps(deps: BffDeps): ResolvedDeps {
  const { messages, clock, config, ...rest } = deps;
  return {
    ...rest,
    messages: messages ?? defaultCatalog,
    clock: clock ?? { now: () => new Date() },
    // `loadEnv` throws in production when a connection value is missing (M6);
    // reading it here means the process cannot come up half-configured.
    config: { env: config?.env ?? loadEnv(), ...DEFAULT_CONFIG, ...config },
    diagnostics: commandDiagnosticsOf(deps.work),
    counters: { droppedUnbound: 0, droppedKillSwitch: 0, invalidCommands: 0 },
  };
}

export interface BuildServerOptions {
  fastify?: FastifyServerOptions;
}

/**
 * The single data door (M7). Studio never touches the database; everything it
 * knows arrives through these routes, and every one of them authenticates —
 * the REST surface with a session token, the webhooks with the delivery
 * signature their port verifies.
 *
 * The catalog is checked before a socket is opened (M6/M104): a service that
 * cannot render the sentence it owes a user must not accept traffic, because
 * the failure would otherwise surface as a raw key inside a bank's Jira ticket.
 */
export async function buildServer(
  deps: BffDeps,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const resolved = resolveDeps(deps);
  assertCatalog(resolved.messages, resolved.config.locale);

  // `options.fastify` may override the limit deliberately, but it is never
  // absent: an unset bodyLimit silently becomes Fastify's 1 MB.
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES, ...options.fastify });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      const body: Record<string, unknown> = { error: error.code };
      if (error.details !== undefined) body["details"] = error.details;
      void reply.code(error.status).send(body);
      return;
    }
    if (typeof error.statusCode === "number" && error.statusCode < 500) {
      void reply.code(error.statusCode).send({ error: error.code ?? "bad_request" });
      return;
    }
    request.log.error({ err: error }, "unhandled error");
    void reply.code(500).send({ error: "internal_error" });
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ error: "not_found" });
  });

  await app.register(async (scope) => healthRoutes(scope, resolved));
  // Own encapsulation context: the raw-body parser must not reach the JSON API.
  await app.register(async (scope) => webhookRoutes(scope, resolved));
  await app.register(async (scope) => authRoutes(scope, resolved));
  await app.register(async (scope) => runRoutes(scope, resolved));
  await app.register(async (scope) => paramRoutes(scope, resolved));
  await app.register(async (scope) => templateRoutes(scope, resolved));
  await app.register(async (scope) => killSwitchRoutes(scope, resolved));
  // Studio's read surface (M86/M7): the 37 screens read through these, and
  // through the same guards and the same project scoping as everything above.
  await app.register(async (scope) => studioRunRoutes(scope, resolved));
  await app.register(async (scope) => studioOpsRoutes(scope, resolved));
  await app.register(async (scope) => studioCatalogRoutes(scope, resolved));

  app.decorate("maestro", resolved);
  // The MCP surface reads the platform through the SAME container, so an AI and
  // a human asking the same question reach the same read models (M101).
  app.decorate("platform", bffPlatform(resolved));
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    /** The resolved container, for tests and for the composition root. */
    maestro: ResolvedDeps;
    /** `MaestroPlatform` over this container — what maestro-mcp is injected with (M101). */
    platform: MaestroPlatform;
  }
}
