import { SecretKeyError } from "./errors.js";

/**
 * Secret key grammar, shared by EVERY driver so a reference written in DB
 * config resolves identically whatever driver is wired (M80):
 *
 *     <mount>/<path>[#<field>]        e.g. "kv/jira/pat#token", "kv/jira/pat"
 *
 * The first segment is the KV mount, the rest is the path inside it, and the
 * optional `#field` selects a key of the secret object (default: `value`).
 */
export interface SecretKey {
  mount: string;
  path: string;
  field: string;
}

export const DEFAULT_FIELD = "value";

/** Segments may not be empty, `.` or `..` — that is how path traversal starts. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FIELD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseSecretKey(key: string): SecretKey {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new SecretKeyError(String(key), "key is empty");
  }
  const trimmed = key.trim();

  const hashes = trimmed.split("#");
  if (hashes.length > 2) throw new SecretKeyError(trimmed, "at most one '#field' suffix is allowed");
  const [rawPath, rawField] = hashes as [string, string | undefined];

  const field = rawField === undefined ? DEFAULT_FIELD : rawField;
  if (!FIELD.test(field)) throw new SecretKeyError(trimmed, `field "${field}" is not a bare identifier`);

  const segments = rawPath.split("/");
  if (segments.length < 2) throw new SecretKeyError(trimmed, "expected <mount>/<path>[#<field>]");
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw new SecretKeyError(trimmed, `path segment "${segment}" is empty or unsafe`);
    }
  }

  const [mount, ...rest] = segments as [string, ...string[]];
  return { mount, path: rest.join("/"), field };
}

/**
 * Scope of a short-lived credential (M31), e.g. "repo/ugurpay-core/push".
 * Same segment rules; no `#field` — the field comes from configuration.
 */
export function parseScope(scope: string): string {
  if (typeof scope !== "string" || scope.trim().length === 0) {
    throw new SecretKeyError(String(scope), "scope is empty");
  }
  const trimmed = scope.trim();
  if (trimmed.includes("#")) throw new SecretKeyError(trimmed, "scope must not carry a '#field' suffix");
  for (const segment of trimmed.split("/")) {
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw new SecretKeyError(trimmed, `scope segment "${segment}" is empty or unsafe`);
    }
  }
  return trimmed;
}

/**
 * Environment variable name a key maps to in the env-file driver:
 * "kv/jira/pat#token" → "MAESTRO_SECRET_KV_JIRA_PAT__TOKEN".
 */
export function envVarName(key: SecretKey, prefix: string): string {
  const body = `${key.mount}/${key.path}`.replace(/[^A-Za-z0-9]+/g, "_");
  return `${prefix}${body}__${key.field}`.toUpperCase();
}
