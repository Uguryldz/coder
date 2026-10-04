import { CONNECTION_KIND_SPECS, ConnectionKind } from "@maestro/contracts";
import type { ManagedConnectionKind } from "../common/index.ts";

/**
 * What the Bağlantılar screen knows about each connection KIND on top of the
 * shared `CONNECTION_KIND_SPECS` table — the screen-side facts the contract has
 * no reason to carry: which URL schemes a kind accepts, which kinds may run
 * without a credential, which config fields belong under "authentication" and
 * which under "options".
 *
 * Everything keyed by kind lives here, once. The form and the list both read
 * it, so adding a kind is a row in the contract plus a row or two here — never
 * a special case buried in JSX.
 */

/** Every kind, in the contract's own order. */
export const KINDS: readonly ManagedConnectionKind[] = ConnectionKind.options;

/** The families in the order the screen lists them — required ones first. */
export const FAMILIES = ["issue_tracker", "model", "scm", "infra"] as const;
export type Family = (typeof FAMILIES)[number];

export function kindsOf(family: Family): readonly ManagedConnectionKind[] {
  return KINDS.filter((kind) => CONNECTION_KIND_SPECS[kind].family === family);
}

export function familyOf(kind: ManagedConnectionKind): Family {
  return CONNECTION_KIND_SPECS[kind].family;
}

export function isModelKind(kind: ManagedConnectionKind): boolean {
  return CONNECTION_KIND_SPECS[kind].model === true;
}

/** No live probe exists — the list offers no test button, the form says so. */
export function isProbeless(kind: ManagedConnectionKind): boolean {
  return CONNECTION_KIND_SPECS[kind].probeless === true;
}

export function isJiraKind(kind: ManagedConnectionKind): boolean {
  return kind === "jira_cloud" || kind === "jira_dc";
}

/**
 * The URL schemes a kind accepts. SMTP is the one non-HTTP kind: the contract
 * (`z.string().url()`) accepts `smtp://`, the BFF stored it happily, and only
 * the form's http-only check stood in the way — so an SMTP relay could never be
 * saved from Studio at all.
 */
export function allowedProtocols(kind: ManagedConnectionKind): readonly string[] {
  return kind === "smtp" ? ["smtp:", "smtps:"] : ["http:", "https:"];
}

export function isValidBaseUrl(kind: ManagedConnectionKind, value: string): boolean {
  try {
    const url = new URL(value);
    return allowedProtocols(kind).includes(url.protocol) && url.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * The example shown greyed in the URL box.
 *
 * `openai_compat` overrides the contract's example: the BFF strips a trailing
 * `/v1` from that kind (the driver appends its own), and the hint under the box
 * says "without /v1" — a placeholder ending in `/v1` contradicted the hint two
 * lines below it. Every other kind's example is used as-is because for them the
 * stored URL is dialled verbatim.
 */
export function urlPlaceholder(kind: ManagedConnectionKind): string {
  if (kind === "openai_compat") return "http://10.0.0.5:8000";
  return CONNECTION_KIND_SPECS[kind].urlExample;
}

/**
 * Kinds that may be saved WITHOUT a credential.
 *
 * `openai_compat`: a self-hosted vLLM/Ollama on an internal network commonly
 * has no key, and the BFF treats an explicit empty token as "this server wants
 * none". `smtp`/`storage`: an internal relay or bucket may be unauthenticated,
 * and neither has a live probe to prove it either way. Every other kind is a
 * cloud vendor or a Vault — a missing credential there can only ever 401, so
 * the form asks for it up front instead of letting the test discover it.
 */
const TOKEN_OPTIONAL: ReadonlySet<ManagedConnectionKind> = new Set(["openai_compat", "smtp", "storage"]);

export function isTokenRequired(kind: ManagedConnectionKind): boolean {
  return !TOKEN_OPTIONAL.has(kind);
}

/**
 * Kinds for which an EMPTY token is a value to send, not an omission. Only the
 * self-hosted model server: the BFF enciphers "" into a real slot so the driver
 * stops falling back to a `.env` key the operator thought they had replaced.
 */
export function sendsEmptyToken(kind: ManagedConnectionKind): boolean {
  return kind === "openai_compat";
}

/** Config fields that belong under "authentication" rather than "options". */
const AUTH_CONFIG_KEYS: ReadonlySet<string> = new Set(["email"]);

export function isAuthField(key: string): boolean {
  return AUTH_CONFIG_KEYS.has(key);
}

/**
 * The non-secret `config` keys the form owns beyond the contract's field list.
 *
 * `botDisplayName` is read by the BFF when it provisions the Jira bot's own
 * Maestro account (`provisionBot`) and had no box anywhere — it could only be
 * set by editing the database. `skipTlsVerify` is the per-connection TLS
 * switch, stored as the string "true" and REMOVED when off. `botAccountId` is
 * learned by the live test and never typed; it is preserved on edit, not shown.
 */
export const BOT_DISPLAY_NAME_KEY = "botDisplayName";
export const SKIP_TLS_KEY = "skipTlsVerify";
