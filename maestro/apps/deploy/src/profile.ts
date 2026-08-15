import { z } from "zod";

/**
 * Deployment profiles.
 *
 * A profile is the ONE place that answers "which driver serves which port".
 * It is data, not code: `wiring.ts` turns it into registrations, and
 * `assertProfileComplete` refuses a profile with a hole in it before a single
 * connection is opened (M6 fail-closed).
 *
 * `prod` is the bank deployment: Vault for secrets, S3-compatible object
 * storage, Teams+SMTP notifications. `dev` is the offline profile the compose
 * stack boots with: secrets from environment variables, blobs in Postgres,
 * notifications into the Jira ticket. Neither profile is a subset of the
 * other — `dev` is not "prod with things missing", it is a different set of
 * drivers, which is why the choice is explicit rather than a chain of
 * `NODE_ENV` checks scattered through the wiring.
 */

export const PROFILES = ["prod", "dev", "analiz"] as const;
export type Profile = (typeof PROFILES)[number];

export const ProfileName = z.enum(PROFILES);

/**
 * The eight ports `@maestro/workflows`'s `PortSelection` demands, plus `ci`,
 * which only the BFF resolves (the worker never parses a build webhook).
 *
 * The keys are the worker's `PORT_NAMES` keys verbatim — `wiring.ts` builds a
 * `PortSelection` straight out of this, and `test/profile.test.ts` pins the two
 * key sets against each other so a port added upstream cannot be silently
 * dropped here.
 */
export const WORKER_PORT_KEYS = [
  "work",
  "scm",
  "llm",
  "scan",
  "storage",
  "secret",
  "notify",
  "publish",
] as const;
export type WorkerPortKey = (typeof WORKER_PORT_KEYS)[number];

/** Every port this deployment names a driver for. */
export const ALL_PORT_KEYS = [...WORKER_PORT_KEYS, "ci"] as const;
export type PortKey = (typeof ALL_PORT_KEYS)[number];

export type DriverMap = Readonly<Record<PortKey, string>>;

/**
 * Driver ids exactly as each package registers them. They are duplicated here
 * as literals for the same reason `@maestro/workflows` duplicates the port
 * names: naming a driver must not drag its package into this module's import
 * graph. `test/profile.test.ts` pins each id against the exporting package's
 * own constant, so a rename fails the suite rather than the deployment.
 */
/**
 * Driver ids for the two ports the analysis-only release does not serve.
 *
 * They are registered (`registry.ts`) as ports whose every method rejects with
 * a named error, so the failure reads as "this release does not do that"
 * rather than as a connection timeout to an Azure DevOps that was never
 * configured.
 */
export const SCM_UNAVAILABLE_DRIVER = "unavailable";
export const CI_UNAVAILABLE_DRIVER = "unavailable";
/**
 * Scanning is part of the engineering turn — it reads a diff — so the
 * analysis-only release does not serve it either. Its real driver demands a
 * digest-pinned image (M27), correctly, and demanding one for a port nothing
 * in this release calls is the same wall as `ADO_BASE_URL`.
 */
export const SCAN_UNAVAILABLE_DRIVER = "unavailable";

const PROD_DRIVERS: DriverMap = {
  work: "jira-dc",
  scm: "ado",
  ci: "ado",
  llm: "gateway",
  scan: "trivy",
  storage: "s3-compat",
  secret: "vault",
  notify: "multi",
  publish: "multi",
};

const DEV_DRIVERS: DriverMap = {
  work: "jira-dc",
  scm: "ado",
  ci: "ado",
  llm: "gateway",
  scan: "trivy",
  storage: "pg-blob",
  // No Vault in the dev stack: the env-file driver reads `MAESTRO_SECRET_*`.
  // The driver itself refuses to serve when NODE_ENV is production (M80), so
  // this choice cannot leak into a bank deployment by way of a stale profile.
  secret: "env-file",
  notify: "jira",
  publish: "jira",
};

/**
 * The analysis-only deployment: ticket in, analysis document out.
 *
 * This is what the product ships today — intake, analysis, the human gate and
 * delivery. The engineering half (write code, open a PR, merge) exists in the
 * workflow but is not part of this release, so the two ports that serve it get
 * a driver that REFUSES rather than one that is configured.
 *
 * Refusing beats omitting. A profile with a hole in it is rejected by
 * `assertProfileComplete` before a connection opens (M6), and a profile that
 * named a real ADO driver would demand `ADO_BASE_URL` from an operator who has
 * no Azure DevOps — which is exactly the wall this profile removes. What is
 * left is a deployment that runs the analysis line end to end and answers any
 * attempt to reach the engineering line with a named error instead of a
 * connection attempt to nowhere.
 *
 * `work` is Cloud here because that is the site this profile was written
 * against. A bank on Data Center overrides it with `WORK_DRIVER=jira-dc`.
 */
const ANALYSIS_DRIVERS: DriverMap = {
  work: "jira-cloud",
  scm: SCM_UNAVAILABLE_DRIVER,
  ci: CI_UNAVAILABLE_DRIVER,
  llm: "gateway",
  scan: SCAN_UNAVAILABLE_DRIVER,
  storage: "pg-blob",
  secret: "env-file",
  notify: "jira",
  publish: "jira",
};

export const PROFILE_DRIVERS: Readonly<Record<Profile, DriverMap>> = {
  prod: PROD_DRIVERS,
  dev: DEV_DRIVERS,
  analiz: ANALYSIS_DRIVERS,
};

export function driversFor(profile: Profile): DriverMap {
  return PROFILE_DRIVERS[profile];
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

/**
 * Refuse a driver map with a missing or blank entry.
 *
 * The map is typed `Record<PortKey, string>`, so this can only fire on a value
 * that arrived at runtime — a profile built from configuration rather than from
 * the constants above. That is exactly the case worth guarding: a port left
 * `undefined` resolves to `registry.resolve(port, undefined)`, and the error a
 * developer would eventually see names the driver, not the port that has none.
 */
export function assertProfileComplete(drivers: DriverMap, profile: string): void {
  const missing = ALL_PORT_KEYS.filter((key) => {
    const driver: unknown = drivers[key];
    return typeof driver !== "string" || driver.trim() === "";
  });
  if (missing.length > 0) {
    throw new ProfileError(
      `profile "${profile}": no driver named for port(s) ${missing.join(", ")} — ` +
        "every port must be filled at composition time (M6/M44)",
    );
  }
}

/** Parse a profile name, naming the alternatives rather than just refusing. */
export function parseProfile(value: string | undefined): Profile {
  const parsed = ProfileName.safeParse(value);
  if (!parsed.success) {
    throw new ProfileError(
      `MAESTRO_PROFILE: "${value ?? "(unset)"}" is not a deployment profile — expected one of ${PROFILES.join(", ")}`,
    );
  }
  return parsed.data;
}
