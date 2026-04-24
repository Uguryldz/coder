import { z } from "zod";

/**
 * Environment config. Loaded once, validated with Zod.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  API_PORT: z.coerce.number().default(3000),
  STUDIO_PORT: z.coerce.number().default(3001),
  CORRELATION_ID_HEADER: z.string().default("x-correlation-id"),

  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default("redis://localhost:6379/0"),

  S3_ENDPOINT: z.string().default("http://localhost:9000"),
  S3_ACCESS_KEY: z.string().default("orkestra"),
  S3_SECRET_KEY: z.string().default("orkestra-dev-secret"),
  S3_BUCKET: z.string().default("orkestra"),
  S3_REGION: z.string().default("us-east-1"),

  VAULT_ADDR: z.string().default("http://localhost:8200"),
  VAULT_TOKEN: z.string().default("orkestra-dev-root"),
  VAULT_MOUNT: z.string().default("secret"),

  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("orkestra"),

  LLM_MODE: z.enum(["mock", "real"]).default("mock"),
  ANTHROPIC_API_KEY: z.string().default(""),
  CLAUDE_MODEL_OPUS: z.string().default("claude-opus-4-7"),
  CLAUDE_MODEL_SONNET: z.string().default("claude-sonnet-4-6"),
  CLAUDE_MODEL_HAIKU: z.string().default("claude-haiku-4-5-20251001"),

  JIRA_BASE_URL: z.string().default("http://localhost:8080"),
  JIRA_USERNAME: z.string().default(""),
  JIRA_API_TOKEN: z.string().default(""),
  JIRA_WEBHOOK_SECRET: z.string().default("change-me"),

  BITBUCKET_BASE_URL: z.string().default("http://localhost:7990"),
  BITBUCKET_USERNAME: z.string().default(""),
  BITBUCKET_APP_PASSWORD: z.string().default(""),
  BITBUCKET_WEBHOOK_SECRET: z.string().default("change-me"),

  SLACK_WEBHOOK_URL: z.string().default(""),
  TESTRAIL_BASE_URL: z.string().default(""),
  TESTRAIL_USER: z.string().default(""),
  TESTRAIL_API_KEY: z.string().default(""),

  NEXTAUTH_URL: z.string().default("http://localhost:3001"),
  NEXTAUTH_SECRET: z.string().default("change-me"),

  COST_BUDGET_PER_WORKFLOW_USD: z.coerce.number().default(5),
  ANTHROPIC_RPM_LIMIT: z.coerce.number().default(4000),
  ANTHROPIC_TPM_INPUT_LIMIT: z.coerce.number().default(2_000_000),
  SANDBOX_MAX_CONCURRENT: z.coerce.number().default(4),
});

export type Config = z.infer<typeof EnvSchema>;

let _cfg: Config | undefined;

export function loadConfig(): Config {
  if (!_cfg) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      console.error("[config] invalid environment:", parsed.error.flatten());
      throw new Error("Invalid environment config");
    }
    _cfg = parsed.data;
  }
  return _cfg;
}

export function isMockMode(): boolean {
  return loadConfig().LLM_MODE === "mock";
}

export function isDev(): boolean {
  return loadConfig().NODE_ENV === "development";
}

export { createLogger, logger } from "./logger.js";
