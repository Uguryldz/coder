import { z } from "zod";

/**
 * Process environment schema. Fail-closed (M6): in production every
 * connection value must be present — the process refuses to start rather
 * than run half-configured. Dev gets local defaults.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * Where the BFF listens. Studio is served on 7000 and calls 7001 (M7 port
   * map). The default HOST is loopback on purpose: a service that binds
   * 0.0.0.0 because nobody set a variable is exposed by omission, and inside a
   * container the compose file sets this explicitly.
   */
  BFF_PORT: z.coerce.number().int().min(1).max(65535).default(7001),
  BFF_HOST: z.string().min(1).default("127.0.0.1"),
  DATABASE_URL: z.url().optional(),
  TEMPORAL_ADDRESS: z.string().min(1).optional(),
  JIRA_BASE_URL: z.url().optional(),
  ADO_BASE_URL: z.url().optional(),
  VAULT_ADDR: z.url().optional(),
  STORAGE_ENDPOINT: z.url().optional(),
  EGRESS_PROXY_URL: z.url().optional(),
  /**
   * Redis, for cross-process coordination (M4): the atomic token bucket
   * (M19), the capacity semaphore, the distributed lock and the cache layer.
   *
   * `z.string()` rather than `z.url()`, unlike every other endpoint above:
   * Zod's URL check demands a scheme it recognises, and `redis://` /
   * `rediss://` are refused by it. `parseRedisUrl` in `@maestro/cache` does
   * the real validation — scheme, host, database index — and it does it at
   * boot, so a malformed value still fails in front of an operator rather
   * than at the first rate-limit check.
   *
   * Required in production, and the reason is not tidiness: without it every
   * replica runs a process-local token bucket, so N replicas grant N times the
   * configured LLM rate and N times the sandbox capacity. That is a bill and an
   * outage, not a degradation, which is why it sits in REQUIRED_IN_PROD below.
   */
  REDIS_URL: z.string().min(1).optional(),
});
export type Env = z.infer<typeof EnvSchema>;

const REQUIRED_IN_PROD = [
  "DATABASE_URL",
  "TEMPORAL_ADDRESS",
  "JIRA_BASE_URL",
  "ADO_BASE_URL",
  "VAULT_ADDR",
  "STORAGE_ENDPOINT",
] as const;

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`environment validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "EnvValidationError";
  }
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvValidationError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  const env = parsed.data;
  if (env.NODE_ENV === "production") {
    const missing = REQUIRED_IN_PROD.filter((k) => env[k] === undefined);
    if (missing.length > 0) {
      throw new EnvValidationError(missing.map((k) => `${k}: required in production (M6 fail-closed)`));
    }
  }
  return env;
}
