import { z } from "zod";

/**
 * Process environment schema. Fail-closed (M6): in production every
 * connection value must be present — the process refuses to start rather
 * than run half-configured. Dev gets local defaults.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url().optional(),
  TEMPORAL_ADDRESS: z.string().min(1).optional(),
  JIRA_BASE_URL: z.url().optional(),
  ADO_BASE_URL: z.url().optional(),
  VAULT_ADDR: z.url().optional(),
  STORAGE_ENDPOINT: z.url().optional(),
  EGRESS_PROXY_URL: z.url().optional(),
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
