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

  // ── identity: AD/LDAPS (M8) ─────────────────────────────────────────────
  /**
   * Which identity driver the deployment uses. `local` is the MVP bcrypt
   * store; `ldaps-bind` authenticates against the bank's directory.
   *
   * Defaulting to `local` keeps every existing dev setup and test working
   * unchanged; a bank deployment sets this to `ldaps-bind` and is then held to
   * the LDAP_* requirements below.
   */
  IDENTITY_DRIVER: z.enum(["local", "ldaps-bind"]).default("local"),
  /** `ldaps://ad.bank.local:636`. Plain `ldap://` is refused in production. */
  LDAP_URL: z.string().min(1).optional(),
  /** Where user search starts, e.g. `OU=Users,DC=bank,DC=local`. */
  LDAP_USER_BASE_DN: z.string().min(1).optional(),
  /** Where group search starts. Falls back to the user base when unset. */
  LDAP_GROUP_BASE_DN: z.string().min(1).optional(),
  /** Service account DN used for the SEARCH bind — never for a user's bind. */
  LDAP_BIND_DN: z.string().min(1).optional(),
  /**
   * The service-account password is a secret REFERENCE and lives in
   * `apps/deploy`'s `DeployEnvSchema` with every other `*_REF`, NOT here.
   * That file owns the pointers, and `secret-names.test.ts` derives the
   * `MAESTRO_SECRET_*` variable names from its defaults — a reference declared
   * in this schema would be invisible to that check.
   */
  /** PEM path for the bank's own CA. Corporate roots are not publicly trusted. */
  LDAP_CA_CERT_PATH: z.string().min(1).optional(),
  /** User search filter carrying `{{username}}`; the driver escapes the value. */
  LDAP_USER_FILTER: z.string().min(1).optional(),
  /** Group membership filter carrying `{{dn}}`. */
  LDAP_GROUP_FILTER: z.string().min(1).optional(),
  /**
   * Group → role mapping, as `group:role1|role2` entries separated by commas:
   *
   *     maestro-admins:admin,maestro-qa:qa,maestro-leads:tech-lead|developer
   *
   * The bank's AD naming is a deployment fact, not a platform convention — this
   * is what replaces the hardcoded `maestro-<projectkey>` rule.
   */
  LDAP_ROLE_MAPPINGS: z.string().optional(),
  /**
   * Escape hatch for a local test directory with no TLS. Refused outright when
   * `NODE_ENV=production`, whatever this says. Named for what it does: the
   * variable someone would set to break this should read badly in review.
   */
  LDAP_ALLOW_INSECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
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
  /**
   * Added when `@maestro/cache` landed (orchestrator, 2026-08-09). Its author
   * left it out of this list on purpose — the list is a cross-cutting contract
   * that dozens of tests lean on, and a package should not widen it mid-wave —
   * and guarded the same property inside `resolveCacheMode` instead. With the
   * wave merged, it belongs here too.
   *
   * The reason is not tidiness. Without Redis every replica runs a
   * process-local token bucket, so N replicas grant N times the configured LLM
   * rate and N times the sandbox capacity. That is a bill and an outage, not a
   * degradation — and it is invisible until it happens.
   */
  "REDIS_URL",
] as const;

/**
 * What the LDAPS identity driver cannot start without. No default is possible
 * for any of them: they are facts about the bank's directory, and a guessed
 * base DN does not fail — it silently finds nobody.
 */
const REQUIRED_FOR_LDAP = ["LDAP_URL", "LDAP_USER_BASE_DN", "LDAP_BIND_DN"] as const;

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
  const issues: string[] = [];

  if (env.NODE_ENV === "production") {
    for (const k of REQUIRED_IN_PROD) {
      if (env[k] === undefined) issues.push(`${k}: required in production (M6 fail-closed)`);
    }
  }

  /**
   * The LDAPS driver's own required set (M8).
   *
   * Checked whenever the driver is SELECTED rather than only in production, so
   * a half-configured directory fails at boot on a developer's machine too —
   * the alternative is discovering it at the first login attempt, which is
   * both later and harder to read.
   */
  if (env.IDENTITY_DRIVER === "ldaps-bind") {
    for (const k of REQUIRED_FOR_LDAP) {
      if (env[k] === undefined) {
        issues.push(`${k}: required when IDENTITY_DRIVER=ldaps-bind`);
      }
    }
    /**
     * TLS is enforced here as well as inside the driver. Two checks because
     * this one runs at BOOT with nothing else configured, and catches the
     * deployment before it ever serves a login form.
     */
    if (env.NODE_ENV === "production" && env.LDAP_URL?.startsWith("ldaps://") === false) {
      issues.push(
        "LDAP_URL: must be ldaps:// in production — a plain ldap:// bind sends the user's " +
          "corporate password in cleartext",
      );
    }
    if (env.NODE_ENV === "production" && env.LDAP_ALLOW_INSECURE) {
      issues.push("LDAP_ALLOW_INSECURE: must not be true in production");
    }
  }

  if (issues.length > 0) throw new EnvValidationError(issues);
  return env;
}
