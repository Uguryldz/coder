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

export const PROFILES = ["prod", "dev"] as const;
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

export const PROFILE_DRIVERS: Readonly<Record<Profile, DriverMap>> = {
  prod: PROD_DRIVERS,
  dev: DEV_DRIVERS,
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
