import { normalizeProjectStatuses, normalizeProjectIssueTypes } from "@maestro/adapter-jira";
import type { ConnectionKind } from "@maestro/contracts";
import type { ConnectionRecord } from "./connection-store.js";
import type { ConnectorFetch } from "./connection-service.js";

/**
 * The values a listening rule can match on for a project — the project's real
 * STATUS names or ISSUE-TYPE names, read LIVE off Jira with the connection's
 * stored token. This turns the rule form's "Değer" field from free text (where
 * "hata" vs "Hata" silently matches nothing) into a dropdown of exactly the
 * names Jira will present, so a mistyped value is impossible.
 *
 * Both come from the SAME endpoint the M102 workflow-import screen already uses
 * (`GET /project/{key}/statuses`): it groups statuses by issue type, so the
 * top-level names are the issue types and the nested names are the statuses.
 * One call answers both `kind`s.
 */

export type MatchValueKind = "status" | "issuetype";

export type MatchValuesResult =
  | { ok: true; values: readonly string[] }
  | { ok: false; messageKey: string; messageParams?: Record<string, string> };

interface Source {
  /** `/project/{key}/statuses`, per Jira flavour. */
  path(projectKey: string): string;
  header(token: string, email: string): Record<string, string>;
}

function basic(user: string, token: string): string {
  return `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
}

/** Header schemes mirror `connection-service.ts`'s `probeFor` exactly. */
export function jiraMatchSource(kind: ConnectionKind): Source | null {
  switch (kind) {
    case "jira_cloud":
      return {
        path: (key) => `/rest/api/3/project/${encodeURIComponent(key)}/statuses`,
        header: (token, email) => ({ authorization: basic(email, token) }),
      };
    case "jira_dc":
      return {
        path: (key) => `/rest/api/2/project/${encodeURIComponent(key)}/statuses`,
        header: (token) => ({ authorization: `Bearer ${token}` }),
      };
    default:
      return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * List a project's status names or issue-type names via a stored connection.
 * `token` is resolved by the caller from `secretRef` (never passed in plain from
 * a client). Failures are secret-free catalog keys, never prose that could carry
 * the URL/token.
 */
export async function listJiraMatchValues(
  connection: ConnectionRecord,
  projectKey: string,
  kind: MatchValueKind,
  token: string | null,
  fetchImpl: ConnectorFetch,
): Promise<MatchValuesResult> {
  const source = jiraMatchSource(connection.kind);
  if (source === null) {
    return { ok: false, messageKey: "onboard.jira.not_listable", messageParams: { kind: connection.kind } };
  }
  if (token === null) return { ok: false, messageKey: "onboard.jira.no_token" };
  if (projectKey.trim().length === 0) return { ok: false, messageKey: "onboard.jira.bad_response" };

  const email = str((connection.config as { email?: unknown } | null)?.email) ?? "";
  const url = `${connection.baseUrl.replace(/\/+$/, "")}${source.path(projectKey.trim())}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", ...source.header(token, email) },
    });
  } catch {
    return { ok: false, messageKey: "onboard.jira.unreachable" };
  }

  if (response.status < 200 || response.status >= 300) {
    return { ok: false, messageKey: "onboard.jira.http_error", messageParams: { status: String(response.status) } };
  }

  try {
    const raw = await response.json();
    const values = kind === "status" ? normalizeProjectStatuses(raw).map((s) => s.name) : normalizeProjectIssueTypes(raw);
    // De-duplicate status names (the endpoint repeats a status per issue type).
    return { ok: true, values: [...new Set(values)] };
  } catch {
    return { ok: false, messageKey: "onboard.jira.bad_response" };
  }
}
