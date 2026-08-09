import type { DeployEnv } from "./env.js";
import { vaultMounts } from "./env.js";
import type { PortKey, Profile } from "./profile.js";

/**
 * Per-port driver configuration, built from the environment.
 *
 * These are the `config` halves of `PortSelection` — declarative objects each
 * driver validates with its own Zod schema. Nothing here contains a secret
 * VALUE: every credential appears as a reference the driver resolves through
 * the SecretPort at call time (M80). That is what makes it safe for
 * `logWiring` to print a summary of this at boot.
 */

export class DeployConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployConfigError";
  }
}

function required<T>(value: T | undefined, name: string, why: string): T {
  if (value === undefined) {
    throw new DeployConfigError(`${name}: ${why}`);
  }
  return value;
}

export function jiraConfig(env: DeployEnv, secrets: unknown): Record<string, unknown> {
  return {
    baseUrl: required(env.base.JIRA_BASE_URL, "JIRA_BASE_URL", "the work port has no default instance"),
    tokenRef: env.JIRA_TOKEN_REF,
    webhookSecretRef: env.JIRA_WEBHOOK_SECRET_REF,
    deps: { secrets },
  };
}

/**
 * ADO serves both the `scm` and the `ci` port from one config.
 *
 * `ci.prValidationBuilds` is an allow-list the driver refuses to leave empty:
 * without it any pipeline in the organisation could answer for a pull
 * request's validation gate (M12). It therefore has no default here either —
 * an operator must name the definitions, and the failure to do so is a startup
 * error rather than a gate that quietly accepts everything.
 */
export function adoConfig(env: DeployEnv): Record<string, unknown> {
  const baseUrl = required(env.base.ADO_BASE_URL, "ADO_BASE_URL", "the scm/ci ports have no default instance");
  const org = required(env.ADO_ORG, "ADO_ORG", "required to address the Azure DevOps collection");
  const project = required(env.ADO_PROJECT, "ADO_PROJECT", "required by the CI allow-list");
  return {
    mode: "services",
    org,
    baseUrl,
    tokenRef: env.ADO_TOKEN_REF,
    ci: {
      webhookSecretRef: env.ADO_WEBHOOK_SECRET_REF,
      webhookUsername: env.ADO_WEBHOOK_USERNAME,
      prValidationBuilds: parsePrValidationBuilds(env, project),
    },
  };
}

/**
 * `ADO_PR_VALIDATION_BUILDS` as `repo:definitionId` pairs, comma separated.
 * A malformed entry is refused rather than skipped: silently dropping one
 * would shrink the allow-list, and a shrunken allow-list looks exactly like a
 * gate that never opens.
 */
export function parsePrValidationBuilds(
  env: DeployEnv,
  project: string,
): { project: string; repository: string; definitionId: number }[] {
  const raw = env.ADO_PR_VALIDATION_BUILDS;
  if (raw === undefined || raw.trim() === "") {
    throw new DeployConfigError(
      "ADO_PR_VALIDATION_BUILDS: required — the CI gate needs an explicit allow-list of " +
        'PR-validation definitions ("repo:definitionId", comma separated); an empty list is refused, not "allow all" (M12)',
    );
  }
  return raw.split(",").map((entry) => {
    const trimmed = entry.trim();
    const separator = trimmed.lastIndexOf(":");
    const repository = separator === -1 ? "" : trimmed.slice(0, separator).trim();
    const definitionId = Number(trimmed.slice(separator + 1));
    if (repository === "" || !Number.isInteger(definitionId) || definitionId <= 0) {
      throw new DeployConfigError(
        `ADO_PR_VALIDATION_BUILDS: "${trimmed}" is not a "repo:definitionId" pair with a positive integer id`,
      );
    }
    return { project, repository, definitionId };
  });
}

/**
 * Storage config. The two drivers take different shapes and neither is a
 * degraded version of the other, so the profile picks one outright.
 *
 * `s3-compat` needs the access key as a VALUE, not a reference — SigV4 signs
 * with the key material itself. It is therefore resolved from the SecretPort
 * by the caller and passed in, which is why this function takes credentials
 * rather than reading them.
 */
export function storageConfig(
  env: DeployEnv,
  profile: Profile,
  s3Credentials?: { accessKeyId: string; secretAccessKey: string },
  sql?: unknown,
  fetchImpl?: unknown,
): Record<string, unknown> {
  if (profile === "prod") {
    const credentials = required(s3Credentials, "STORAGE credentials", "the s3-compat driver signs with key material");
    return {
      endpoint: required(env.base.STORAGE_ENDPOINT, "STORAGE_ENDPOINT", "the s3-compat driver has no default endpoint"),
      region: env.STORAGE_REGION,
      bucket: env.STORAGE_BUCKET,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      fetch: fetchImpl ?? globalThis.fetch,
    };
  }
  return {
    table: "storage_blob",
    sql: required(sql, "storage sql executor", "the pg-blob driver writes through an injected SqlExecutor"),
  };
}

/**
 * The LLM gateway.
 *
 * `onPremMissing: "degrade_ai_assist"` is the driver's own default and the
 * only honest one for a bank: when no on-prem model is reachable, the platform
 * stops offering AI assistance rather than shipping a `gizli` payload to a
 * cloud endpoint. The demo overrides it to `masked_cloud` because it has no
 * on-prem model at all; a real deployment must not inherit that choice, so it
 * is left at the default here deliberately.
 */
export function llmConfig(env: DeployEnv): Record<string, unknown> {
  const baseUrl = required(env.LLM_BASE_URL, "LLM_BASE_URL", "the llm port has no default endpoint");
  const driver = "openai-compat";
  return {
    drivers: [
      {
        driver,
        baseUrl,
        apiKeyRef: env.LLM_API_KEY_REF,
        onPrem: env.LLM_ON_PREM,
        timeoutMs: 90_000,
      },
    ],
    bindings: [
      { role: "intake", driver, model: env.LLM_MODEL },
      { role: "analyst", driver, model: env.LLM_MODEL },
      { role: "engineer", driver, model: env.LLM_MODEL },
    ],
    routes: [
      { dataClass: "acik", allowedDrivers: [driver] },
      { dataClass: "dahili", allowedDrivers: [driver] },
      { dataClass: "gizli", allowedDrivers: [driver] },
    ],
  };
}

/**
 * Scanner config.
 *
 * The image must be digest-pinned (M27) and the driver refuses anything else,
 * so there is no default to fall back on: a deployment that has not named a
 * scanner image has not decided what its gate measures. `SCAN_IMAGE_TRIVY`
 * names the one the profile selects; the other two tools are configured the
 * same way once they are selectable.
 */
export function scanConfig(env: DeployEnv, driver: string): Record<string, unknown> {
  const byTool: Record<string, string | undefined> = {
    trivy: env.SCAN_IMAGE_TRIVY,
    semgrep: env.SCAN_IMAGE_SEMGREP,
    gitleaks: env.SCAN_IMAGE_GITLEAKS,
  };
  const variable = `SCAN_IMAGE_${driver.toUpperCase()}`;
  const image = required(
    byTool[driver],
    variable,
    `required — the ${driver} gate needs a digest-pinned image; a tag can change under a passing gate (M27)`,
  );
  return { image };
}

/** Notification config; `multi` fans out, `jira` posts on the ticket. */
export function notifyConfig(profile: Profile): Record<string, unknown> {
  return profile === "prod" ? { jira: {} } : {};
}

/** Publish config; `multi` needs the project's explicit target set (M47). */
export function publishConfig(profile: Profile): Record<string, unknown> {
  return profile === "prod" ? { targets: ["jira"] } : {};
}

/** The secret driver's own config, so the registry can rebuild it by name. */
export function secretConfig(env: DeployEnv, profile: Profile, deps: unknown): Record<string, unknown> {
  const allowedMounts = vaultMounts(env);
  if (profile === "prod") {
    return { addr: env.base.VAULT_ADDR, allowedMounts, deps };
  }
  return { allowedMounts, deps: { nodeEnv: env.base.NODE_ENV } };
}

/** Every port's config in one map, keyed exactly like `PortSelection`. */
export type DriverConfigMap = Readonly<Record<PortKey, unknown>>;
