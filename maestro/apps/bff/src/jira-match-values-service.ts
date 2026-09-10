import { type JiraFieldInfo, normalizeFieldList, normalizeProjectStatuses, normalizeProjectIssueTypes } from "@maestro/adapter-jira";
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
 * STATUSES come from `GET /project/{key}/statuses` — the same endpoint the M102
 * workflow-import screen uses. It groups statuses by issue type, so the nested
 * names are the statuses, and those ARE the names on the issues (verified live
 * against project OPS: `İNCELEMEDE / Yapılacaklar / Tamam / Devam Ediyor` are
 * exactly what `fields.status.name` carries). That branch is load-bearing for
 * the status-map feature and is left alone.
 *
 * ISSUE TYPES do NOT come from that payload, and this is the trap. Its
 * top-level `name` per group is the issue type in a DIFFERENT LOCALISATION from
 * the issue resource — Jira renders that endpoint's type names in the site's
 * default/English locale while `/issue/{key}` returns the project's translated
 * ones. Measured live on OPS:
 *
 *   /rest/api/3/project/OPS/statuses            -> Epic, Subtask, Task,  Story,  Feature, Bug
 *   /rest/api/3/issue/createmeta/OPS/issuetypes -> Epik, Subtask, Görev, Hikaye, Feature, Hata
 *   issue OPS-66 fields.issuetype.name          -> Görev
 *
 * `flow-decision.ts` compares `rule.matchValue` to the ticket's `issueType`,
 * which is `fields.issuetype.name` verbatim. So a rule built from the statuses
 * payload says `Task` and matches NOTHING, silently, forever. Issue types are
 * therefore read from `createmeta/{key}/issuetypes`, whose names agree with the
 * issue resource. One extra call, and only for `kind=issuetype`.
 *
 * ── THE SECOND TRAP: TEAM-MANAGED PROJECTS TAKE IDS, NOT NAMES ─────────────
 *
 * The names above are right for the WEBHOOK path (`flow-decision.ts` string
 * compare), but the DISCOVERY path builds JQL, and on a team-managed project
 * ("next-gen", `simplified: true`) JQL does not accept issue-type or status
 * NAMES at all. It does not error either — it returns an empty page. Measured
 * live on OPS over one and the same ticket set:
 *
 *   issuetype = "Görev"          ->  0 tickets
 *   issuetype = 10008            -> 14 tickets
 *   status in ("Yapılacaklar")   ->  0 tickets
 *   status = 10004               -> 12 tickets
 *
 * So on such a project a rule whose `matchValue` is a NAME scans nothing,
 * forever, with no error anywhere. `jira-discovery.ts`'s `jqlFor` already
 * writes a numeric `matchValue` unquoted, so the fix is upstream of it: the
 * operator must be able to SAVE the id. This module therefore reports, next to
 * every value, the `id` Jira gave it (`options`), plus whether the project is
 * team-managed (`teamManaged`) so the screen knows which of the two to store.
 * `values` stays names-only for every existing caller.
 */

export type MatchValueKind = "status" | "issuetype";

/**
 * One selectable value with BOTH of its identities: the `name` an operator
 * reads and the `id` JQL wants on a team-managed project. `id` may be absent
 * only where the source truly carries none (the degraded statuses fallback for
 * issue types) — an option without an id is still pickable, it just cannot be
 * saved in the id form.
 */
export interface MatchValueOption {
  readonly name: string;
  readonly id: string;
}

export type MatchValuesResult =
  | {
      ok: true;
      values: readonly string[];
      /**
       * The same values as `values`, each with its Jira id. Additive on
       * purpose: `values` predates this and every existing caller still reads
       * names off it, while a caller that must build JQL on a team-managed
       * project reads the id from here.
       */
      options?: readonly MatchValueOption[];
      /**
       * `true` when Jira reports the project as team-managed ("next-gen" /
       * `simplified`), where JQL matches issue types and statuses ONLY by id.
       * The screen picks which form to store from this. Fail-soft: an
       * unreadable project resource reports `false`, which is the behaviour
       * that shipped before this field existed.
       */
      teamManaged?: boolean;
      /**
       * Set when the issue-type list came from the FALLBACK source, so the
       * names may be the wrong localisation (see the module comment). The
       * dropdown is still offered — a stale list an operator can eyeball beats
       * an empty one with no explanation — but the caller can say so.
       */
      degraded?: true;
      degradedKey?: string;
    }
  | { ok: false; messageKey: string; messageParams?: Record<string, string> };

interface Source {
  /** `/project/{key}/statuses`, per Jira flavour. */
  path(projectKey: string): string;
  /**
   * `/issue/createmeta/{key}/issuetypes`, per Jira flavour — the only source
   * whose issue-type names match the ones on issues. `null` where we have not
   * verified the endpoint exists, and that flavour keeps `path` for both kinds.
   */
  issueTypePath?(projectKey: string): string;
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
        issueTypePath: (key) => `/rest/api/3/issue/createmeta/${encodeURIComponent(key)}/issuetypes`,
        header: (token, email) => ({ authorization: basic(email, token) }),
      };
    case "jira_dc":
      // No `issueTypePath` ON PURPOSE. Server/DC documents the same
      // `/rest/api/2/issue/createmeta/{key}/issuetypes`, but we have no DC
      // instance to measure it against — and on older DC builds it 404s. Since
      // DC's localisation trap is unproven while breaking the working list is
      // certain, DC stays on `/project/{key}/statuses` for both kinds until
      // someone can verify a real deployment. Fix Cloud; do not guess at DC.
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

/** `id` as a string, whether Jira serialised it as `"10008"` or `10008`. */
function idOf(record: Record<string, unknown>): string {
  const raw = record["id"];
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return "";
}

/**
 * Issue-type NAME + ID pairs out of a createmeta issuetypes body.
 *
 * The array has lived under two keys across Jira versions — `issueTypes` on
 * current Cloud, `values` on the paginated shape — so both are accepted rather
 * than pinning to whichever one this site happens to serve today. Anything else
 * is `null`, which the caller reads as "this source did not answer" and
 * degrades on, not as "this project has no issue types".
 *
 * The id rides along because a team-managed project's JQL only matches on it
 * (see the module comment's live measurement).
 */
export function parseCreateMetaIssueTypeOptions(raw: unknown): MatchValueOption[] | null {
  const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  if (body === null) return null;
  const list = Array.isArray(body["issueTypes"])
    ? body["issueTypes"]
    : Array.isArray(body["values"])
      ? body["values"]
      : null;
  if (list === null) return null;

  const seen = new Set<string>();
  const out: MatchValueOption[] = [];
  for (const entry of list) {
    const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const trimmed = str(record["name"])?.trim();
    // Subtask types are KEPT — a rule may legitimately target one, same call
    // the adapter's `normalizeProjectIssueTypes` makes.
    if (trimmed !== undefined && trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push({ name: trimmed, id: idOf(record) });
    }
  }
  // An empty-but-well-formed page is still an answer we refuse to trust over
  // the fallback: a project always has at least one creatable issue type, so
  // zero here means the caller lacks create permission, not that none exist.
  return out.length > 0 ? out : null;
}

/** Names-only view of the above — the shape this module exported before ids. */
export function parseCreateMetaIssueTypes(raw: unknown): string[] | null {
  const options = parseCreateMetaIssueTypeOptions(raw);
  return options === null ? null : options.map((option) => option.name);
}

/** One GET with the flavour's auth; `null` on anything that is not a 2xx body. */
async function readJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: ConnectorFetch,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: "unreachable" | "http" | "body"; status?: number }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json", ...headers } });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, reason: "http", status: response.status };
  }
  try {
    return { ok: true, body: await response.json() };
  } catch {
    return { ok: false, reason: "body" };
  }
}

/**
 * Is this project TEAM-MANAGED? `GET /project/{key}` reports it two ways —
 * `style: "next-gen"` and `simplified: true` — and either alone is enough,
 * because older Cloud builds carry only `simplified` while some payloads carry
 * only `style`. It matters because a team-managed project's JQL matches issue
 * types and statuses by id ONLY (see the module comment).
 *
 * FAIL-SOFT: any failure answers `false`. A company-managed project is what the
 * whole feature assumed before this probe existed, and a read that could not be
 * made must not silently flip every rule of a working deployment to ids.
 */
export function isTeamManagedProject(raw: unknown): boolean {
  const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  if (body === null) return false;
  return body["simplified"] === true || str(body["style"])?.trim().toLowerCase() === "next-gen";
}

async function readTeamManaged(
  base: string,
  projectKey: string,
  kind: ConnectionKind,
  headers: Record<string, string>,
  fetchImpl: ConnectorFetch,
): Promise<boolean> {
  const api = kind === "jira_cloud" ? "/rest/api/3" : "/rest/api/2";
  const read = await readJson(`${base}${api}/project/${encodeURIComponent(projectKey)}`, headers, fetchImpl);
  return read.ok ? isTeamManagedProject(read.body) : false;
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
  const base = connection.baseUrl.replace(/\/+$/, "");
  const key = projectKey.trim();
  const headers = source.header(token, email);

  // Whether the project is team-managed decides which FORM the screen saves —
  // id or name — so it is answered on the same call that hands over the list.
  // One extra GET, fail-soft; deliberately not a second endpoint, because a
  // screen that had to ask twice could render a list before it knew what to do
  // with it.
  const teamManaged = await readTeamManaged(base, key, connection.kind, headers, fetchImpl);

  // ── issue types: the createmeta source first, the statuses payload as a net ──
  if (kind === "issuetype" && source.issueTypePath !== undefined) {
    const meta = await readJson(`${base}${source.issueTypePath(key)}`, headers, fetchImpl);
    if (meta.ok) {
      const options = parseCreateMetaIssueTypeOptions(meta.body);
      if (options !== null) {
        return { ok: true, values: options.map((o) => o.name), options, teamManaged };
      }
    }
    // createmeta is missing (older deployment), forbidden (no create permission
    // in this project), or shaped in a way we do not recognise. Fall through to
    // the statuses payload rather than handing back an empty dropdown: the
    // names may be the wrong localisation, but a list an operator can read and
    // correct beats a blank box that explains nothing. `degraded` says so out
    // loud so the screen and anyone reading the response can tell which it is.
    const fallback = await readJson(`${base}${source.path(key)}`, headers, fetchImpl);
    if (!fallback.ok) return failure(fallback);
    try {
      const names = normalizeProjectIssueTypes(fallback.body);
      if (names.length === 0) return { ok: false, messageKey: "onboard.jira.bad_response" };
      return {
        ok: true,
        values: [...new Set(names)],
        options: issueTypeOptionsFromStatuses(fallback.body, names),
        teamManaged,
        degraded: true,
        degradedKey: "onboard.jira.issuetypes_degraded",
      };
    } catch {
      return { ok: false, messageKey: "onboard.jira.bad_response" };
    }
  }

  // ── statuses (and DC's issue types) off /project/{key}/statuses, unchanged ──
  const read = await readJson(`${base}${source.path(key)}`, headers, fetchImpl);
  if (!read.ok) return failure(read);
  try {
    if (kind === "status") {
      // De-duplicate status names (the endpoint repeats a status per issue
      // type); `normalizeProjectStatuses` already de-duplicates BY ID, so the
      // options list is one entry per real status and carries the id JQL needs.
      const statuses = normalizeProjectStatuses(read.body);
      const options = statuses.map((status) => ({ name: status.name, id: status.id }));
      return { ok: true, values: [...new Set(statuses.map((s) => s.name))], options, teamManaged };
    }
    const names = [...new Set(normalizeProjectIssueTypes(read.body))];
    return { ok: true, values: names, options: issueTypeOptionsFromStatuses(read.body, names), teamManaged };
  } catch {
    return { ok: false, messageKey: "onboard.jira.bad_response" };
  }
}

/**
 * Issue-type ids off a `/project/{key}/statuses` body, paired with the names
 * the adapter already extracted from it. Used only where createmeta could not
 * answer: the group's own `id` IS the issue-type id even though the group's
 * `name` may be the wrong localisation, so the id half of the pair stays usable
 * exactly where the name half is not. A group with no id yields `""`, which the
 * screen treats as "no id form available for this one".
 */
function issueTypeOptionsFromStatuses(raw: unknown, names: readonly string[]): MatchValueOption[] {
  const byName = new Map<string, string>();
  if (Array.isArray(raw)) {
    for (const group of raw) {
      const record = typeof group === "object" && group !== null ? (group as Record<string, unknown>) : {};
      const name = str(record["name"])?.trim();
      if (name !== undefined && name !== "" && !byName.has(name)) byName.set(name, idOf(record));
    }
  }
  return names.map((name) => ({ name, id: byName.get(name) ?? "" }));
}

/** A failed read as the same secret-free catalog keys this module always spoke. */
function failure(read: { reason: "unreachable" | "http" | "body"; status?: number }): MatchValuesResult {
  if (read.reason === "unreachable") return { ok: false, messageKey: "onboard.jira.unreachable" };
  if (read.reason === "http") {
    return { ok: false, messageKey: "onboard.jira.http_error", messageParams: { status: String(read.status ?? 0) } };
  }
  return { ok: false, messageKey: "onboard.jira.bad_response" };
}

export type JiraFieldsResult =
  | { ok: true; fields: readonly JiraFieldInfo[] }
  | { ok: false; messageKey: string; messageParams?: Record<string, string> };

/**
 * The fields an operator can build a repo map on — `GET /rest/api/{2,3}/field`,
 * custom fields first. Same connection/token handling as the match values.
 */
/**
 * Field ids a PROJECT actually uses: its create screens (createmeta, every
 * issue type) — and when that answers nothing, the fields carrying a value on
 * the project's recent tickets. A bank's Jira defines hundreds of fields; the
 * repo map only wants the handful this project shows.
 */
export function fieldIdsFromCreateMeta(raw: unknown): Set<string> {
  const out = new Set<string>();
  const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  const projects = body !== null && Array.isArray(body["projects"]) ? (body["projects"] as unknown[]) : [];
  for (const project of projects) {
    const types = typeof project === "object" && project !== null ? (project as Record<string, unknown>)["issuetypes"] : null;
    for (const type of Array.isArray(types) ? types : []) {
      const fields = typeof type === "object" && type !== null ? (type as Record<string, unknown>)["fields"] : null;
      if (typeof fields === "object" && fields !== null) for (const id of Object.keys(fields)) out.add(id);
    }
  }
  return out;
}

export function fieldIdsWithValues(raw: unknown): Set<string> {
  const out = new Set<string>();
  const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  const issues = body !== null && Array.isArray(body["issues"]) ? (body["issues"] as unknown[]) : [];
  for (const issue of issues) {
    const fields = typeof issue === "object" && issue !== null ? (issue as Record<string, unknown>)["fields"] : null;
    if (typeof fields !== "object" || fields === null) continue;
    for (const [id, value] of Object.entries(fields as Record<string, unknown>)) {
      if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
      out.add(id);
    }
  }
  return out;
}

export async function listJiraFields(
  connection: ConnectionRecord,
  token: string | null,
  fetchImpl: ConnectorFetch,
  projectKey?: string,
): Promise<JiraFieldsResult> {
  const source = jiraMatchSource(connection.kind);
  if (source === null) {
    return { ok: false, messageKey: "onboard.jira.not_listable", messageParams: { kind: connection.kind } };
  }
  if (token === null) return { ok: false, messageKey: "onboard.jira.no_token" };
  const email = str((connection.config as { email?: unknown } | null)?.email) ?? "";
  const base = connection.baseUrl.replace(/\/+$/, "");
  const path = connection.kind === "jira_cloud" ? "/rest/api/3/field" : "/rest/api/2/field";
  const read = await readJson(`${base}${path}`, source.header(token, email), fetchImpl);
  if (!read.ok) {
    const failed = failure(read);
    return failed.ok ? { ok: false, messageKey: "onboard.jira.bad_response" } : failed;
  }
  const fields = normalizeFieldList(read.body);
  if (fields.length === 0) return { ok: false, messageKey: "onboard.jira.bad_response" };
  const key = projectKey?.trim() ?? "";
  if (key === "") return { ok: true, fields };
  // Narrow to the project: create screens first, then fields with values.
  const headers = source.header(token, email);
  const cloud = connection.kind === "jira_cloud";
  const metaPath = `${cloud ? "/rest/api/3" : "/rest/api/2"}/issue/createmeta?projectKeys=${encodeURIComponent(key)}&expand=projects.issuetypes.fields`;
  const meta = await readJson(`${base}${metaPath}`, headers, fetchImpl);
  let used = meta.ok ? fieldIdsFromCreateMeta(meta.body) : new Set<string>();
  if (used.size === 0) {
    const jql = encodeURIComponent(`project = "${key.replace(/"/g, "")}" ORDER BY updated DESC`);
    const searchPath = cloud
      ? `/rest/api/3/search/jql?jql=${jql}&fields=*navigable&maxResults=50`
      : `/rest/api/2/search?jql=${jql}&fields=*navigable&maxResults=50`;
    const sample = await readJson(`${base}${searchPath}`, headers, fetchImpl);
    if (sample.ok) used = fieldIdsWithValues(sample.body);
  }
  if (used.size === 0) return { ok: true, fields };
  // ORDER, never hide: a field shared across projects ("İş Ailesi") may sit on
  // no create screen of this project and still be the one the operator maps
  // on. The project's own fields lead; the rest follow, marked.
  const ranked = fields.map((field) => ({ ...field, scope: used.has(field.id) ? ("project" as const) : ("other" as const) }));
  ranked.sort(
    (a, b) =>
      Number(a.scope === "other") - Number(b.scope === "other") ||
      Number(b.custom) - Number(a.custom) ||
      a.name.localeCompare(b.name, "tr"),
  );
  return { ok: true, fields: ranked };
}

export type JiraFieldValuesResult =
  | { ok: true; values: readonly string[]; source: "createmeta" | "editmeta" | "options" | "sample" }
  | { ok: false; messageKey: string; messageParams?: Record<string, string> };

/** Walk a createmeta body for `fields[fieldId].allowedValues` in any project/issue type. */
export function allowedValuesFromCreateMeta(raw: unknown, fieldId: string): string[] {
  const out = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    const field = record[fieldId];
    if (typeof field === "object" && field !== null && Array.isArray((field as Record<string, unknown>)["allowedValues"])) {
      for (const option of (field as Record<string, unknown>)["allowedValues"] as unknown[]) {
        const text = fieldOptionText(option);
        if (text !== null) out.add(text);
      }
    }
    for (const child of Object.values(record)) if (typeof child === "object" && child !== null) visit(child);
  };
  visit(raw);
  return [...out];
}

/**
 * DÖRT ANAHTAR, ÜÇ DEĞİL — ve sırası `fieldText` ile AYNI.
 *
 * Bu fonksiyon bir dönem yalnız `value` ve `name` okuyordu. Sonuç sahada
 * ölçüldü: "Atanan Kişi" ve "Raporlayan" alanlarında değer kutusu BOŞ
 * geliyordu, çünkü Jira bir kullanıcıyı `{ displayName, accountId }` olarak
 * döner — ne `value` ne `name` taşır. Alan listede duruyor, tıklanıyor, ama
 * seçenek çıkmıyordu; operatörün gördüğü şey "bu alan çalışmıyor"du.
 *
 * Anahtar sırası `fieldText` ile birebir aynı tutuluyor (`value`, `name`,
 * `displayName`, `key`) ve bu tesadüf değil: BURASI operatöre listelenen
 * metni üretir, ORASI ise ticket geldiğinde eşleştirilecek metni. İkisi
 * ayrışırsa operatör listeden bir şey seçer, motor başka bir metinle
 * karşılaştırır ve eşleşme hiçbir zaman tutmaz — sessizce, hatasız.
 */
function fieldOptionText(option: unknown): string | null {
  if (typeof option === "string") return option.trim() === "" ? null : option.trim();
  if (typeof option !== "object" || option === null) return null;
  const record = option as Record<string, unknown>;
  for (const key of ["value", "name", "displayName", "key"]) {
    const text = record[key];
    if (typeof text === "string" && text.trim() !== "") return text.trim();
  }
  return null;
}

/** Distinct values of `fieldId` across a search body's issues (used values). */
export function sampledValuesFromSearch(raw: unknown, fieldId: string): string[] {
  const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  const issues = body !== null && Array.isArray(body["issues"]) ? (body["issues"] as unknown[]) : [];
  const out = new Set<string>();
  for (const issue of issues) {
    const fields = typeof issue === "object" && issue !== null ? ((issue as Record<string, unknown>)["fields"] as Record<string, unknown> | undefined) : undefined;
    const value = fields?.[fieldId];
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const text = fieldOptionText(item);
      if (text !== null) out.add(text);
    }
  }
  return [...out];
}

/**
 * The values a repo map can pick for one field: Jira's allowed values when the
 * field has a fixed option list (createmeta), otherwise the values actually
 * used on the project's tickets (a bounded search). Either way the operator
 * picks from what Jira really carries instead of typing "Krediler" by hand.
 */
export async function listJiraFieldValues(
  connection: ConnectionRecord,
  projectKey: string,
  fieldId: string,
  token: string | null,
  fetchImpl: ConnectorFetch,
): Promise<JiraFieldValuesResult> {
  const source = jiraMatchSource(connection.kind);
  if (source === null) {
    return { ok: false, messageKey: "onboard.jira.not_listable", messageParams: { kind: connection.kind } };
  }
  if (token === null) return { ok: false, messageKey: "onboard.jira.no_token" };
  const key = projectKey.trim();
  const field = fieldId.trim();
  if (key === "" || !/^[A-Za-z0-9_]+$/.test(field)) return { ok: false, messageKey: "onboard.jira.bad_response" };
  const email = str((connection.config as { email?: unknown } | null)?.email) ?? "";
  const base = connection.baseUrl.replace(/\/+$/, "");
  const headers = source.header(token, email);
  const cloud = connection.kind === "jira_cloud";
  const metaPath = cloud
    ? `/rest/api/3/issue/createmeta?projectKeys=${encodeURIComponent(key)}&expand=projects.issuetypes.fields`
    : `/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(key)}&expand=projects.issuetypes.fields`;
  const sorted = (values: readonly string[]): string[] => [...values].sort((a, b) => a.localeCompare(b, "tr"));
  // 1. The create screens' option list (createmeta).
  const meta = await readJson(`${base}${metaPath}`, headers, fetchImpl);
  if (meta.ok) {
    const allowed = allowedValuesFromCreateMeta(meta.body, field);
    if (allowed.length > 0) return { ok: true, values: sorted(allowed), source: "createmeta" };
  }
  // 2. A select field that lives on the EDIT screen only ("İş Ailesi" filled
  //    after creation) is absent from createmeta; the edit screen of any
  //    recent ticket of the project still carries the whole option list.
  const jql = encodeURIComponent(`project = "${key.replace(/"/g, "")}" ORDER BY updated DESC`);
  const searchPath = cloud
    ? `/rest/api/3/search/jql?jql=${jql}&fields=${encodeURIComponent(field)}&maxResults=200`
    : `/rest/api/2/search?jql=${jql}&fields=${encodeURIComponent(field)}&maxResults=200`;
  const sample = await readJson(`${base}${searchPath}`, headers, fetchImpl);
  if (!sample.ok) {
    const failed = failure(sample);
    return failed.ok ? { ok: false, messageKey: "onboard.jira.bad_response" } : failed;
  }
  const api = cloud ? "/rest/api/3" : "/rest/api/2";
  for (const issueKey of issueKeysFromSearch(sample.body).slice(0, 3)) {
    const edit = await readJson(`${base}${api}/issue/${encodeURIComponent(issueKey)}/editmeta`, headers, fetchImpl);
    if (!edit.ok) continue;
    const allowed = allowedValuesFromCreateMeta(edit.body, field);
    if (allowed.length > 0) return { ok: true, values: sorted(allowed), source: "editmeta" };
  }
  // 3. Cloud: the field's own contexts and options — the full list even when
  //    no ticket carries a value yet (needs Jira admin on the token).
  if (cloud) {
    const options = await cloudFieldOptions(base, field, headers, fetchImpl);
    if (options.length > 0) return { ok: true, values: sorted(options), source: "options" };
  }
  // 4. Last: the values in use on the project's tickets.
  const used = sampledValuesFromSearch(sample.body, field);
  if (used.length === 0) return { ok: false, messageKey: "onboard.jira.field_no_values" };
  return { ok: true, values: sorted(used), source: "sample" };
}

/** Issue keys of a search body, newest first as the query ordered them. */
export function issueKeysFromSearch(raw: unknown): string[] {
  const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  const issues = body !== null && Array.isArray(body["issues"]) ? (body["issues"] as unknown[]) : [];
  return issues
    .map((issue) => (typeof issue === "object" && issue !== null ? (issue as Record<string, unknown>)["key"] : undefined))
    .filter((key): key is string => typeof key === "string" && key.trim() !== "");
}

/** Cloud: every option of every context of a select field. */
async function cloudFieldOptions(
  base: string,
  fieldId: string,
  headers: Record<string, string>,
  fetchImpl: ConnectorFetch,
): Promise<string[]> {
  const contexts = await readJson(`${base}/rest/api/3/field/${encodeURIComponent(fieldId)}/context?maxResults=50`, headers, fetchImpl);
  if (!contexts.ok) return [];
  const list = (contexts.body as { values?: unknown } | null)?.values;
  const ids = Array.isArray(list)
    ? list.map((c) => (typeof c === "object" && c !== null ? (c as Record<string, unknown>)["id"] : undefined)).filter((id): id is string | number => typeof id === "string" || typeof id === "number")
    : [];
  const out = new Set<string>();
  for (const id of ids.slice(0, 5)) {
    for (let start = 0; start < 1000; start += 100) {
      const page = await readJson(
        `${base}/rest/api/3/field/${encodeURIComponent(fieldId)}/context/${encodeURIComponent(String(id))}/option?maxResults=100&startAt=${String(start)}`,
        headers,
        fetchImpl,
      );
      if (!page.ok) break;
      const body = page.body as { values?: unknown; isLast?: unknown } | null;
      const values = Array.isArray(body?.values) ? body.values : [];
      for (const option of values) {
        const record = typeof option === "object" && option !== null ? (option as Record<string, unknown>) : {};
        if (record["disabled"] === true) continue;
        const text = fieldOptionText(option);
        if (text !== null) out.add(text);
      }
      if (body?.isLast !== false || values.length === 0) break;
    }
  }
  return [...out];
}

export interface JiraUser {
  /** What a listening rule stores in `assigneeAccountId` and compares against. */
  readonly accountId: string;
  readonly displayName: string;
  readonly email?: string;
  readonly active: boolean;
}

export type JiraUsersResult =
  | { ok: true; users: readonly JiraUser[] }
  | { ok: false; messageKey: string; messageParams?: Record<string, string> };

/**
 * One user out of a search body, across the two flavours' identifier schemes.
 *
 * Cloud has `accountId` (the 24-hex GUID an operator otherwise hand-copies).
 * DC never issues one: its stable handle is `key`, with `name` (the login) as
 * the older equivalent — `flow-decision.ts` compares whatever the webhook's
 * assignee carries, so the SAME field the deployment reports is the one we
 * store. Taking Cloud-only here would leave DC with a dropdown of blanks.
 */
function parseJiraUser(raw: unknown): JiraUser | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const accountId = str(record["accountId"]) ?? str(record["key"]) ?? str(record["name"]);
  if (accountId === undefined) return null;
  // A display name is presentation only; falling back to the id keeps a user
  // pickable on a deployment that hides names rather than dropping the row.
  const displayName = str(record["displayName"]) ?? accountId;
  const email = str(record["emailAddress"]) ?? str(record["email"]);
  // Absent `active` means active: DC omits it on some builds, and treating the
  // omission as "disabled" would empty the list on exactly those deployments.
  const active = record["active"] !== false;
  return { accountId: accountId.trim(), displayName: displayName.trim(), ...(email === undefined ? {} : { email: email.trim() }), active };
}

/**
 * The Jira users a listening rule's "bot account" can be picked from — so the
 * operator selects a person instead of typing a 24-character account id, where
 * one wrong character means the rule silently matches nothing forever.
 *
 * An empty `query` is legal and asks Jira for its first page; the caller's
 * screen uses it to show something before the operator has typed anything.
 * Same connection/token discipline as the rest of this module: the token is
 * resolved by the caller and failures are secret-free catalog keys.
 */
export async function listJiraUsers(
  connection: ConnectionRecord,
  query: string,
  token: string | null,
  fetchImpl: ConnectorFetch,
): Promise<JiraUsersResult> {
  const source = jiraMatchSource(connection.kind);
  if (source === null) {
    return { ok: false, messageKey: "onboard.jira.not_listable", messageParams: { kind: connection.kind } };
  }
  if (token === null) return { ok: false, messageKey: "onboard.jira.no_token" };

  const email = str((connection.config as { email?: unknown } | null)?.email) ?? "";
  const base = connection.baseUrl.replace(/\/+$/, "");
  const q = encodeURIComponent(query.trim());
  // The two flavours disagree on both the version and the parameter name:
  // Cloud's `/api/3/user/search` takes `query` (name OR email), DC's
  // `/api/2/user/search` takes `username`.
  const path =
    connection.kind === "jira_cloud"
      ? `/rest/api/3/user/search?query=${q}&maxResults=50`
      : `/rest/api/2/user/search?username=${q}&maxResults=50`;

  const read = await readJson(`${base}${path}`, source.header(token, email), fetchImpl);
  if (!read.ok) {
    const failed = failure(read);
    return failed.ok ? { ok: false, messageKey: "onboard.jira.bad_response" } : failed;
  }
  if (!Array.isArray(read.body)) return { ok: false, messageKey: "onboard.jira.bad_response" };

  const seen = new Set<string>();
  const users: JiraUser[] = [];
  for (const entry of read.body) {
    const user = parseJiraUser(entry);
    // Deactivated accounts are dropped: a rule pointed at one can never fire,
    // so offering it is offering a silent failure.
    if (user === null || !user.active || seen.has(user.accountId)) continue;
    seen.add(user.accountId);
    users.push(user);
  }
  return { ok: true, users };
}
