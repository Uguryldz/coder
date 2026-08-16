import type { Connection, ConnectionInput, ConnectionKind } from "@maestro/contracts";
import type { ConnectionRecord } from "./connection-store.js";

/**
 * The connector service: turning a validated `ConnectionInput` into a stored
 * `ConnectionRecord`, masking a token for read, and running the LIVE test.
 *
 * Two rules run through all of it. First, a raw token appears in exactly one
 * place — the inbound `ConnectionInput.token` — and never leaves this process:
 * it is enciphered by the caller's `SecretPort`, and what a read returns is a
 * four-character mask, never the value. Second, the test uses the STORED
 * credential, never one the caller supplied on the test request: a viewer who
 * could hand a token to a test endpoint could exfiltrate it to any URL, so the
 * test reads the connection's own secret and only reports ok/fail.
 */

/**
 * The fetch the live test uses. Injected so an OFFLINE test stubs the target
 * with no network, and so the test path never reaches for a global. The URL is
 * built by this service from the STORED `baseUrl` — never from the request
 * body — so a test cannot be pointed at an arbitrary host by its caller.
 */
export type ConnectorFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The last four characters of a token — the only glimpse a read is ever given. */
export function maskToken(token: string): string {
  // Fewer than four chars: mask the whole thing rather than reveal a short
  // token in full. The mask is for recognition, not verification.
  return token.length <= 4 ? "*".repeat(token.length) : token.slice(-4);
}

/**
 * The read shape: the frozen contract `Connection` PLUS the secret-free
 * `lastTestNote`. The note is a BFF/presentation field (the catalog key of the
 * last test's outcome), so it lives here as an intersection rather than an edit
 * to the frozen `Connection` schema.
 */
export type ManagedConnectionView = Connection & { readonly lastTestNote: string | null };

/** The record shape a read hands back — the store record MINUS anything secret. */
export function toConnectionView(record: ConnectionRecord): ManagedConnectionView {
  return {
    id: record.id,
    kind: record.kind,
    displayName: record.displayName,
    baseUrl: record.baseUrl,
    authKind: record.authKind,
    config: record.config,
    // `secretRef` IS returned (it is a reference, not the token) so the screen
    // can reason about which secret slot is in use; the token itself never is.
    secretRef: record.secretRef,
    secretMask: record.secretMask,
    secretSet: record.secretRef !== null,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastTestedAt: record.lastTestedAt,
    lastTestOk: record.lastTestOk,
    lastTestNote: record.lastTestNote,
  };
}

/**
 * Build the record to store from a validated input.
 *
 * The token is NOT part of the record — the caller enciphers it separately and
 * passes the resulting `secretRef`/`secretMask` here. Passing `null` for both
 * keeps whatever was already set (an edit that did not change the token).
 */
export function toConnectionRecord(
  id: string,
  input: ConnectionInput,
  secret: { ref: string | null; mask: string | null },
  timestamps: {
    createdAt: string;
    updatedAt: string;
    lastTestedAt: string | null;
    lastTestOk: boolean | null;
    /** Optional; a create/config-edit that never tested carries no note. */
    lastTestNote?: string | null;
  },
): ConnectionRecord {
  return {
    id,
    kind: input.kind,
    displayName: input.displayName,
    baseUrl: input.baseUrl,
    authKind: input.authKind,
    config: input.config,
    secretRef: secret.ref,
    secretMask: secret.mask,
    enabled: input.enabled,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
    lastTestedAt: timestamps.lastTestedAt,
    lastTestOk: timestamps.lastTestOk,
    lastTestNote: timestamps.lastTestNote ?? null,
  };
}

/** The outcome of a live test — a boolean and a SHORT message (never the token). */
export interface TestOutcome {
  ok: boolean;
  /**
   * A catalog key describing the outcome (M104), plus params the sentence needs.
   * Never prose, and never anything derived from the token — at most the account
   * name / login the target returned, which is not a secret.
   */
  messageKey: string;
  messageParams?: Record<string, string>;
  /**
   * The authenticated account's stable id, when the probe could read one (Jira's
   * `accountId`). The caller persists it on the connection so a listening rule
   * can offer "the bot" instead of asking for a hand-copied GUID. Never a secret.
   */
  accountId?: string;
  /**
   * The stored `config.botAccountId` did NOT match the account the token
   * actually belongs to, and was corrected to `accountId`. Carries the DISPLACED
   * value so the panel can name what was wrong; never an email.
   */
  accountIdCorrected?: { from: string };
}

/** Where each kind's identity/health probe lives, relative to `baseUrl`. */
interface Probe {
  path: string;
  /** How the stored token is presented. */
  header(token: string, config: Record<string, string>): Record<string, string>;
  /** How to read a friendly identity out of a 200 body, if any. */
  identity?(body: unknown): string | undefined;
  /** How to read the authenticated account's stable id (Jira only, for now). */
  accountId?(body: unknown): string | undefined;
}

/** A stored PAT under HTTP Basic (`email:token`), base64 — Jira Cloud's scheme. */
function basicAuth(user: string, token: string): string {
  return `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function field(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  return asString((body as Record<string, unknown>)[key]);
}

/**
 * The probe per kind. `null` = "no live test implemented for this kind yet",
 * reported honestly rather than faked green.
 */
export function probeFor(kind: ConnectionKind): Probe | null {
  switch (kind) {
    case "jira_cloud":
      // Jira Cloud authenticates a PAT with the account email under Basic.
      return {
        path: "/rest/api/3/myself",
        header: (token, config) => ({ authorization: basicAuth(config["email"] ?? "", token) }),
        // `displayName` ONLY. `/myself` also returns `emailAddress`, and the old
        // fallback to it would have rendered the bot's email into the panel and
        // into the stored test note — the response is PII, so only the name and
        // the opaque accountId are ever allowed out of this probe.
        identity: (body) => field(body, "displayName"),
        // The bot's Jira accountId — captured so a listening rule can pre-fill it
        // instead of an operator hand-copying a 40-char GUID from a profile URL.
        accountId: (body) => field(body, "accountId"),
      };
    case "jira_dc":
      // Data Center takes the PAT as a bearer token.
      return {
        path: "/rest/api/2/myself",
        header: (token) => ({ authorization: `Bearer ${token}` }),
        identity: (body) => field(body, "displayName") ?? field(body, "name"),
        // DC identifies a user by `key`/`name`, not the Cloud accountId shape.
        accountId: (body) => field(body, "key") ?? field(body, "name"),
      };
    case "github":
      return {
        path: "/user",
        header: (token) => ({ authorization: `Bearer ${token}`, "user-agent": "maestro" }),
        identity: (body) => field(body, "login"),
      };
    case "openrouter":
    case "anthropic":
      // Both expose a models endpoint that a valid key can list.
      return {
        path: "/models",
        header: (token): Record<string, string> =>
          kind === "anthropic"
            ? { "x-api-key": token, "anthropic-version": "2023-06-01" }
            : { authorization: `Bearer ${token}` },
      };
    case "vault":
      // A token-lookup-self call is the health-and-auth probe in one.
      return {
        path: "/v1/auth/token/lookup-self",
        header: (token) => ({ "x-vault-token": token }),
      };
    case "ado":
      // Azure DevOps takes the PAT as Basic with an empty username.
      return {
        path: "/_apis/connectionData?api-version=7.1-preview",
        header: (token) => ({ authorization: basicAuth("", token) }),
        identity: (body) => {
          const authed = (body as { authenticatedUser?: { providerDisplayName?: unknown } } | null)
            ?.authenticatedUser?.providerDisplayName;
          return asString(authed);
        },
      };
    case "smtp":
    case "storage":
      // No HTTP identity probe: SMTP is a socket handshake and object storage
      // needs a signed request per provider. Honestly "not implemented yet"
      // rather than a fabricated green.
      return null;
  }
}

/**
 * Run the live test against the STORED connection using the STORED token.
 *
 * The URL is built from `baseUrl` + the kind's probe path — never from anything
 * the caller sent — so a viewer cannot turn the test into an SSRF or an
 * exfiltration channel. A missing token, a non-2xx, a probe that does not exist
 * for this kind, and a thrown fetch are four distinct honest outcomes; none of
 * them is reported as ok, and none of them puts the token in the message.
 */
export async function runConnectionTest(
  record: ConnectionRecord,
  token: string | null,
  fetchImpl: ConnectorFetch,
): Promise<TestOutcome> {
  const probe = probeFor(record.kind);
  if (probe === null) {
    return { ok: false, messageKey: "connections.test.not_implemented", messageParams: { kind: record.kind } };
  }
  if (token === null) {
    return { ok: false, messageKey: "connections.test.no_token" };
  }

  const url = `${record.baseUrl.replace(/\/+$/, "")}${probe.path}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", ...probe.header(token, record.config) },
    });
  } catch {
    // The error is deliberately NOT surfaced: a fetch failure message can carry
    // the URL and, on some runtimes, request headers — which is where the token
    // is. The screen gets an honest "unreachable", not a stack trace.
    return { ok: false, messageKey: "connections.test.unreachable" };
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      messageKey: "connections.test.http_error",
      messageParams: { status: String(response.status) },
    };
  }

  let identity: string | undefined;
  let accountId: string | undefined;
  if (probe.identity !== undefined || probe.accountId !== undefined) {
    try {
      const body = await response.json();
      identity = probe.identity?.(body);
      accountId = probe.accountId?.(body);
    } catch {
      identity = undefined;
      accountId = undefined;
    }
  }

  // The identity check. `accountId` is who the TOKEN belongs to, straight from
  // the live `/myself` answer; `config.botAccountId` is what an operator typed.
  // When they disagree the stored value is wrong by definition — a token cannot
  // act as an account it does not belong to — so the test says so out loud
  // instead of returning a bare green that hides a misattribution.
  const claimed = record.config["botAccountId"]?.trim();

  if (accountId !== undefined && claimed !== undefined && claimed !== "" && claimed !== accountId) {
    return {
      ok: true,
      messageKey: "connections.test.ok_bot_fixed",
      // Both ids, never an email: the operator needs to SEE which value was
      // replaced, or a silent correction looks like nothing happened.
      messageParams: { was: claimed, now: accountId, ...(identity === undefined ? {} : { who: identity }) },
      accountId,
      accountIdCorrected: { from: claimed },
    };
  }

  return identity === undefined
    ? { ok: true, messageKey: "connections.test.ok", accountId }
    : { ok: true, messageKey: "connections.test.ok_as", messageParams: { who: identity }, accountId };
}
