/**
 * Issue-field helpers shared by the Data Center and Cloud ports.
 *
 * ── Alan değeri METİN olarak ────────────────────────────────────────────────
 * The listening rule's repo map compares a Jira field against the operator's
 * text ("Krediler"). Jira returns that field as whatever its type is: a select
 * option `{ value }`, a user `{ displayName }`, a version `{ name }`, a plain
 * string, a number, or a list of those. `fieldText` flattens every one of them
 * to the text a person sees in the issue view, which is what the operator
 * typed into the rule.
 */
export function fieldText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(fieldText).filter((part): part is string => part !== null);
    return parts.length === 0 ? null : parts.join(", ");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["value", "name", "displayName", "key"]) {
      const text = fieldText(record[key]);
      if (text !== null) return text;
    }
  }
  return null;
}

/** `GET /issue/{key}?fields=a,b` body → `{ a: "text", b: "text" }`, absent when empty. */
export function fieldsFromIssue(raw: unknown, fieldIds: readonly string[]): Record<string, string> {
  const issue = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  const fields =
    issue !== null && typeof issue["fields"] === "object" && issue["fields"] !== null
      ? (issue["fields"] as Record<string, unknown>)
      : {};
  const out: Record<string, string> = {};
  for (const id of fieldIds) {
    const text = fieldText(fields[id]);
    if (text !== null) out[id] = text;
  }
  return out;
}

export interface JiraFieldInfo {
  readonly id: string;
  readonly name: string;
  readonly custom: boolean;
  /** Jira schema type when reported (`option`, `string`, `array`, …). */
  readonly type: string | null;
  /** "project" when the project's own screens carry the field; "other" for the rest of the instance. */
  readonly scope?: "project" | "other";
}

/**
 * Custom field TYPES Jira and its plugins add for their own machinery — rank,
 * sprint, epic link, dev panel, issue colour, service-desk sessions.
 * Nobody maps a repository on these; listing them buries the one field
 * ("İş Ailesi") an operator is looking for.
 *
 * `atlassian-team` is NOT here, and that is deliberate. It was, and on a live
 * instance whose only other custom fields were a date picker and a one-option
 * checkbox, dropping it left the operator with nothing to map on. "Which team
 * owns this ticket" is a REAL routing rule — a team maps onto a repository the
 * way a business family does — so the field belongs in the list even though
 * Jira ships it.
 */
const INTERNAL_CUSTOM_TYPES = [
  "gh-lexo-rank",
  "gh-sprint",
  "gh-epic-link",
  "gh-epic-label",
  "gh-epic-status",
  "gh-epic-color",
  "jsw-issue-color",
  "jsw-story-points",
  "devsummarycf",
  "vulnerabilitycf",
  "agent-sessions",
  "jpo-custom",
  "sd-",
  "servicedesk",
];
function internalCustomType(customType: string | null): boolean {
  if (customType === null) return false;
  const tail = customType.split(":").pop() ?? customType;
  return INTERNAL_CUSTOM_TYPES.some((marker) => tail.startsWith(marker) || customType.includes(`:${marker}`));
}

/**
 * `GET /rest/api/{2,3}/field` → the fields an operator can map on. Custom
 * fields first (that is where "İş Ailesi" lives), then the system fields that
 * make sense to map on; the rest of the system fields (summary, description,
 * dates) are noise for a mapping and are left out.
 */
const MAPPABLE_SYSTEM_FIELDS = new Set(["components", "labels", "priority", "issuetype", "fixVersions", "versions"]);
export function normalizeFieldList(raw: unknown): JiraFieldInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: JiraFieldInfo[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record["id"] === "string" ? record["id"].trim() : "";
    const name = typeof record["name"] === "string" ? record["name"].trim() : "";
    if (id === "" || name === "") continue;
    const custom = record["custom"] === true || id.startsWith("customfield_");
    if (!custom && !MAPPABLE_SYSTEM_FIELDS.has(id)) continue;
    const schema = typeof record["schema"] === "object" && record["schema"] !== null ? (record["schema"] as Record<string, unknown>) : null;
    const type = schema !== null && typeof schema["type"] === "string" ? schema["type"] : null;
    const customType = schema !== null && typeof schema["custom"] === "string" ? schema["custom"] : null;
    if (custom && internalCustomType(customType)) continue;
    out.push({ id, name, custom, type });
  }
  return out.sort((a, b) => Number(b.custom) - Number(a.custom) || a.name.localeCompare(b.name, "tr"));
}
