import { z } from "zod";
import { IsoDateTime, NonEmpty } from "./common.js";

/**
 * A managed outbound connection (the connector-management surface).
 *
 * This is the EDITABLE counterpart to the settings screen's read-only
 * `ConnectionView` (deployment facts read from the environment). A `Connection`
 * is a row an admin creates from Studio: a URL, an auth kind, some non-secret
 * config, and a REFERENCE (`secretRef`) to an AES-encrypted token held in the
 * secret store. The raw token is NEVER part of this shape — not on the way in,
 * not on the way out. What travels instead is `secretMask` (last four chars,
 * for recognition) and `secretSet` (whether a token exists at all). A console
 * that could display a PAT is a console that could leak it into a screenshot
 * (M9), and the same rule that keeps the read-only view free of secrets keeps
 * this one free of them too.
 */

/** What this connection speaks to — the probe and the auth path both key off it. */
export const ConnectionKind = z.enum([
  "jira_cloud",
  "jira_dc",
  "github",
  "ado",
  "openrouter",
  "anthropic",
  "vault",
  "smtp",
  "storage",
]);
export type ConnectionKind = z.infer<typeof ConnectionKind>;

/**
 * How the stored token is presented to the target on a live test.
 * `basic` → Basic auth (email:token), `bearer` → `Authorization: Bearer`,
 * `pat` → a personal-access header the kind decides, `api_key` → a key header.
 */
export const ConnectionAuthKind = z.enum(["basic", "bearer", "pat", "api_key"]);
export type ConnectionAuthKind = z.infer<typeof ConnectionAuthKind>;

/**
 * The connection id grammar — lower-case, dash-separated, e.g. `jira`,
 * `llm-openrouter`. Same shape the DB column stores; it doubles as the URL path
 * segment on `/studio/connections/:id`, so it must be URL-safe with no slashes.
 */
export const ConnectionId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export type ConnectionId = z.infer<typeof ConnectionId>;

/**
 * Non-secret configuration a connection needs beyond its URL — the Jira account
 * email, a GitHub owner/repo, a project key. Free-form by design (each kind
 * needs different fields), but bounded: string values only, so a token can
 * never be smuggled in here as "config" and then read back out. The keys and
 * values are size-capped so the JSON column stays a config bag, not a payload.
 */
export const ConnectionConfig = z.record(
  z.string().min(1).max(64),
  z.string().max(1024),
);
export type ConnectionConfig = z.infer<typeof ConnectionConfig>;

/**
 * A connection as READ back — never carries the token, only its mask and a flag.
 *
 * `secretMask` is the last four characters of the stored token (or `null` when
 * none is set); it exists so an operator can recognise WHICH credential is
 * stored without the platform ever handing back the credential itself.
 * `lastTestOk` is a tri-state on purpose: `null` = never tested, `true`/`false`
 * = the last live test's honest verdict. A screen must be able to tell "not yet
 * checked" from "checked and broken".
 */
export const Connection = z.object({
  id: ConnectionId,
  kind: ConnectionKind,
  displayName: NonEmpty.max(120),
  baseUrl: z.string().url().max(2048),
  authKind: ConnectionAuthKind,
  config: ConnectionConfig.default({}),
  /** Reference into the secret store — NEVER the token. Absent until one is set. */
  secretRef: NonEmpty.max(256).nullable().default(null),
  /** Last four chars of the stored token, or null. The only glimpse a read gets. */
  secretMask: z.string().max(4).nullable().default(null),
  /** Whether a token is stored at all — drives the "set / not set" affordance. */
  secretSet: z.boolean().default(false),
  enabled: z.boolean().default(true),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastTestedAt: IsoDateTime.nullable().default(null),
  /** null = never tested; true/false = the last live test's real result. */
  lastTestOk: z.boolean().nullable().default(null),
});
export type Connection = z.infer<typeof Connection>;

/**
 * A create/update payload — what Studio SENDS.
 *
 * `token` is the one place a raw secret appears, and it appears only inbound:
 * it is write-only, optional (a config-only edit omits it), and never echoed
 * back. Absent means "leave the stored token as it is"; present means "encrypt
 * this and replace the reference". The read side (`Connection`) has no `token`
 * field at all, which is what makes "a GET can never return the secret" a
 * property of the type rather than of a careful handler.
 */
export const ConnectionInput = z.object({
  kind: ConnectionKind,
  displayName: NonEmpty.max(120),
  baseUrl: z.string().url().max(2048),
  authKind: ConnectionAuthKind,
  config: ConnectionConfig.default({}),
  enabled: z.boolean().default(true),
  /** Write-only. Present = set/replace the token; absent = keep the existing one. */
  token: z.string().min(1).max(4096).optional(),
});
export type ConnectionInput = z.infer<typeof ConnectionInput>;
