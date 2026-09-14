import { randomBytes } from "node:crypto";
import type { ConnectionRecord } from "./connection-store.js";
import type { ConnectorFetch } from "./connection-service.js";
import type { ResolvedDeps } from "./deps.js";
import { jiraMatchSource, readTeamManaged } from "./jira-match-values-service.js";
import type { FlowType, ListeningRuleRecord, ListeningStore } from "./listening-store.js";

/**
 * Default listening rules — the "works out of the box" seed.
 *
 * When a Jira project is connected, the platform should start listening without
 * an admin hand-writing a rule per issue type. This module derives one
 * `issuetype` rule per REAL (non-subtask) issue type of the project, read live
 * off Jira, and writes only the rules that do not exist yet. The admin's own
 * edits are never overwritten: seeding is additive and idempotent.
 *
 * The flow-type mapping is deliberately conservative:
 *
 *  - bug-like types (Bug / Hata / Defect / Arıza, case-insensitive) → `duzeltme`
 *  - EVERYTHING else → `analiz`
 *  - `gelistirme` is NEVER assigned automatically. Letting an agent write and
 *    push code is a decision a human makes per rule, not a default this seed may
 *    quietly hand out — an auto-seeded "gelistirme" would mean connecting a
 *    project silently authorises code changes on every story in it.
 *
 * Subtask types are excluded: a subtask is carried by its parent's flow, and a
 * rule per subtask type would start duplicate runs for the same piece of work.
 */

/**
 * One issue type as the seed needs it.
 *
 * `id` BİR DÖNEM YOKTU ve bu, takım yönetimli ("next-gen") projelerde
 * tohumlanan her kuralın sonsuza dek hiçbir ticket bulmamasına yol açıyordu.
 * Sebep JQL'de: böyle bir projede Jira, iş tipi ve statü ADLARINI kabul etmez.
 * Hata da vermez — boş sayfa döner. Canlıda OPS üzerinde, aynı ticket kümesinde
 * ölçüldü (`jira-match-values-service.ts` modül yorumu):
 *
 *   issuetype = "Görev"  ->  0 ticket
 *   issuetype = 10008    -> 14 ticket
 *
 * Yani adla tohumlanmış bir kural tarar, hiçbir şey bulmaz, ve hiçbir yerde
 * hata görünmez — bir arızanın alabileceği en yanıltıcı biçim.
 */
export interface SeedIssueType {
  name: string;
  subtask?: boolean;
  /** Jira'nın verdiği sayısal id; takım yönetimli projede JQL BUNU ister. */
  id?: string;
}

export interface SeedResult {
  created: number;
  skipped: number;
  /** The rules this call CREATED (not the pre-existing ones it skipped). */
  rules: ListeningRuleRecord[];
}

/**
 * Issue-type names treated as "this is a defect, run the fix flow". Compared
 * case-insensitively with the Turkish locale so "HATA"/"ARIZA" match their
 * lowercase forms ("hata"/"arıza"); the ASCII spelling "ariza" is included for
 * projects typed without Turkish keyboards.
 */
const BUG_TYPE_NAMES: ReadonlySet<string> = new Set(["bug", "hata", "defect", "arıza", "ariza"]);

function isBugLike(name: string): boolean {
  return BUG_TYPE_NAMES.has(name.trim().toLocaleLowerCase("tr-TR"));
}

/** Fix flows outrank analysis flows: a defect rule should win a priority tie. */
const PRIORITY_DUZELTME = 50;
const PRIORITY_ANALIZ = 100;

/** A Postgres unique-constraint violation (Prisma P2002 or a raw 23505). */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "P2002" || code === "23505";
}

/**
 * Seed the default rules for one project into the store. IDEMPOTENT: a trigger
 * (projectKey, assigneeAccountId, matchKind, matchValue) that already has a rule
 * is SKIPPED — never updated — so an admin who changed a seeded rule's flow type
 * keeps their edit on every later re-seed. Only the missing rules are created.
 */
export async function seedDefaultRules(
  store: ListeningStore,
  projectKey: string,
  assigneeAccountId: string,
  issueTypes: readonly SeedIssueType[],
  /**
   * Proje takım yönetimli mi ("next-gen"). `true` ise kural İD ile yazılır:
   * böyle bir projede JQL adları kabul etmez ve hata da vermez, boş sayfa
   * döner — yani adla tohumlanmış kural sonsuza dek hiçbir ticket bulmaz
   * (`SeedIssueType.id` yorumunda canlı ölçüm var).
   *
   * Varsayılan `false`: bu alan var olmadan önceki davranış. Fail-soft, çünkü
   * proje kaynağı okunamadığında ad yazmak, hiç tohumlamamaktan iyidir —
   * şirket yönetimli projelerde ad zaten doğru biçimdir.
   */
  teamManaged = false,
): Promise<SeedResult> {
  const existing = await store.list();
  const rules: ListeningRuleRecord[] = [];
  let skipped = 0;
  const seen = new Set<string>();

  for (const issueType of issueTypes) {
    const name = issueType.name.trim();
    if (name.length === 0) continue;
    // Subtasks ride their parent's flow; a rule for them would double-start work.
    if (issueType.subtask === true) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    const taken = existing.some(
      (rule) =>
        rule.projectKey === projectKey &&
        rule.assigneeAccountId === assigneeAccountId &&
        rule.matchKind === "issuetype" &&
        rule.matchValue === name,
    );
    if (taken) {
      skipped += 1;
      continue;
    }

    // `gelistirme` deliberately never appears here — see the module comment.
    const flowType: FlowType = isBugLike(name) ? "duzeltme" : "analiz";
    const record: ListeningRuleRecord = {
      ruleId: `lr_${randomBytes(9).toString("hex")}`,
      projectKey,
      assigneeAccountId,
      matchKind: "issuetype",
      /**
       * Takım yönetimli projede İD, şirket yönetiminde AD.
       *
       * İd yoksa ada düşülür: Jira'nın id vermediği bir kaynaktan (bozulmuş
       * statü yedeği) gelen tip hâlâ tohumlanabilmeli — o hâlde kural şirket
       * yönetimli projede çalışır, takım yönetimlide çalışmaz, ki bu zaten
       * bugünkü davranıştır. Sessizce KÖTÜLEŞEN bir şey yok.
       */
      matchValue: teamManaged && issueType.id !== undefined ? issueType.id : name,
      flowType,
      priority: flowType === "duzeltme" ? PRIORITY_DUZELTME : PRIORITY_ANALIZ,
      enabled: true,
      analystVariantId: null,
      engineerVariantId: null,
    };

    try {
      await store.put(record);
    } catch (error) {
      // A concurrent seed (approve + a manual click) hit the unique trigger
      // index first — that is the idempotent skip, not a failure.
      if (isUniqueViolation(error)) {
        skipped += 1;
        continue;
      }
      throw error;
    }
    rules.push(record);
  }

  return { created: rules.length, skipped, rules };
}

// ── reading a project's issue types off live Jira ─────────────────────────────

export type IssueTypesResult =
  | { ok: true; issueTypes: SeedIssueType[] }
  | { ok: false; reason: "issue_types_unavailable" };

/**
 * Parse GET /project/{key}/statuses into `{name, subtask}` pairs. The same
 * payload `normalizeProjectIssueTypes` reads, but KEEPING the top-level
 * `subtask` flag the seed needs (the adapter's normaliser returns names only,
 * because a hand-written rule may legitimately target a subtask type).
 */
export function parseSeedIssueTypes(raw: unknown): SeedIssueType[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SeedIssueType[] = [];
  for (const group of raw) {
    if (typeof group !== "object" || group === null) continue;
    const name = (group as Record<string, unknown>)["name"];
    if (typeof name !== "string" || name.trim().length === 0) continue;
    const id = (group as Record<string, unknown>)["id"];
    out.push({
      name: name.trim(),
      subtask: (group as Record<string, unknown>)["subtask"] === true,
      ...(typeof id === "string" && id.trim() !== "" ? { id: id.trim() } : {}),
    });
  }
  return out;
}

/**
 * Parse a createmeta issuetypes body into the same `{name, subtask}` pairs.
 *
 * `parseCreateMetaIssueTypes` in the match-values service returns names only;
 * the seed needs `subtask` too, so it repeats the two-shape handling here
 * (`{issueTypes:[…]}` on current Cloud, `{values:[…]}` on the paginated shape).
 */
export function parseSeedCreateMetaIssueTypes(raw: unknown): SeedIssueType[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const list = Array.isArray(body["issueTypes"])
    ? body["issueTypes"]
    : Array.isArray(body["values"])
      ? body["values"]
      : null;
  if (list === null) return null;

  const out: SeedIssueType[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as Record<string, unknown>)["name"];
    if (typeof name !== "string" || name.trim().length === 0) continue;
    const id = (entry as Record<string, unknown>)["id"];
    out.push({
      name: name.trim(),
      subtask: (entry as Record<string, unknown>)["subtask"] === true,
      ...(typeof id === "string" && id.trim() !== "" ? { id: id.trim() } : {}),
    });
  }
  // Zero creatable types is not a real project — treat it as "no answer" so the
  // caller degrades to the statuses payload instead of seeding nothing.
  return out.length > 0 ? out : null;
}

/**
 * Read a project's issue types with a stored connection — the same auth scheme
 * and secret discipline as `listJiraMatchValues` (`jiraMatchSource` is shared),
 * and the SAME endpoint preference for the same reason: on Cloud the names on
 * `/project/{key}/statuses` are a different localisation from the names on the
 * issues themselves ("Task" vs "Görev"), so a rule seeded from that payload
 * would never match a ticket. `createmeta/{key}/issuetypes` agrees with the
 * issue resource; the statuses payload is only the net under it. See the module
 * comment on `jira-match-values-service.ts` for the measurements.
 *
 * Every failure still collapses to ONE reason: the seed either has a real type
 * list or it seeds nothing. It never invents type names.
 */
export async function fetchSeedIssueTypes(
  connection: ConnectionRecord,
  projectKey: string,
  token: string | null,
  fetchImpl: ConnectorFetch,
): Promise<IssueTypesResult> {
  const source = jiraMatchSource(connection.kind);
  if (source === null || token === null || projectKey.trim().length === 0) {
    return { ok: false, reason: "issue_types_unavailable" };
  }

  const email =
    typeof connection.config["email"] === "string" ? connection.config["email"] : "";
  const base = connection.baseUrl.replace(/\/+$/, "");
  const key = projectKey.trim();
  const headers = { accept: "application/json", ...source.header(token, email) };

  const read = async (path: string): Promise<unknown | null> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, { method: "GET", headers });
    } catch {
      return null;
    }
    if (response.status < 200 || response.status >= 300) return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  };

  if (source.issueTypePath !== undefined) {
    const body = await read(source.issueTypePath(key));
    const parsed = body === null ? null : parseSeedCreateMetaIssueTypes(body);
    if (parsed !== null) return { ok: true, issueTypes: parsed };
    // createmeta unavailable/403/unrecognised — fall back rather than seeding
    // nothing. Wrong-localisation names an admin can see and edit beat a
    // project that silently listens to no ticket at all.
  }

  const body = await read(source.path(key));
  const issueTypes = body === null ? null : parseSeedIssueTypes(body);
  if (issueTypes === null) return { ok: false, reason: "issue_types_unavailable" };
  return { ok: true, issueTypes };
}

// ── the whole seed for one project, from the wired deps ───────────────────────

export type SeedOutcome =
  | ({ ok: true } & SeedResult)
  | {
      ok: false;
      reason:
        | "listening_unwired"
        | "connections_unwired"
        | "no_jira_connection"
        | "bot_account_unknown"
        | "issue_types_unavailable";
    };

/**
 * Seed the default rules for `projectKey` using whatever the deployment has
 * wired: pick the enabled Jira connection that knows the bot account, read the
 * project's issue types with its stored token, and write the missing rules.
 *
 * Returns a named reason instead of throwing for every "cannot seed" state, so
 * the onboarding approve path can call it fail-soft (a seed that cannot run
 * must never break an approval) and the manual endpoint can answer honestly.
 */
export async function seedProjectDefaults(
  deps: ResolvedDeps,
  projectKey: string,
): Promise<SeedOutcome> {
  if (deps.listening === undefined) return { ok: false, reason: "listening_unwired" };
  if (deps.connections === undefined || deps.connectorSecrets === undefined) {
    return { ok: false, reason: "connections_unwired" };
  }

  const jiraConnections = (await deps.connections.list()).filter(
    (connection) =>
      connection.enabled && (connection.kind === "jira_cloud" || connection.kind === "jira_dc"),
  );
  if (jiraConnections.length === 0) return { ok: false, reason: "no_jira_connection" };

  // The assignee every seeded rule listens for is the bot identity the
  // connection test learned (`config.botAccountId`) — the same source the rule
  // form's "the bot" shortcut reads (`GET /onboarding/jira-connections`). A
  // connection that was never tested knows no bot, and a rule with a made-up
  // assignee would match nothing forever, so seeding refuses instead.
  const connection = jiraConnections.find(
    (candidate) =>
      typeof candidate.config["botAccountId"] === "string" &&
      candidate.config["botAccountId"].trim().length > 0,
  );
  if (connection === undefined) return { ok: false, reason: "bot_account_unknown" };
  const botAccountId = connection.config["botAccountId"]!.trim();

  const token =
    connection.secretRef === null
      ? null
      : await deps.connectorSecrets.get(connection.secretRef).catch(() => null);

  const fetched = await fetchSeedIssueTypes(connection, projectKey, token, deps.connectorFetch);
  if (!fetched.ok) return { ok: false, reason: fetched.reason };

  /**
   * Projenin takım yönetimli olup olmadığı, kuralın hangi BİÇİMDE yazılacağına
   * karar verir (ad mı, id mi) — ayrıntısı `seedDefaultRules`ın parametresinde.
   * Okunamıyorsa `false` döner ve tohum ad yazar; bu, bu kontrol var olmadan
   * önceki davranıştır, yani okuma başarısızlığı hiçbir şeyi kötüleştirmez.
   */
  const matchSource = jiraMatchSource(connection.kind);
  const teamManaged =
    matchSource === null || token === null
      ? false
      : await readTeamManaged(
          connection.baseUrl.replace(/\/+$/u, ""),
          projectKey,
          connection.kind,
          matchSource.header(
            token,
            typeof connection.config["email"] === "string" ? connection.config["email"] : "",
          ),
          deps.connectorFetch,
        ).catch(() => false);

  const result = await seedDefaultRules(
    deps.listening,
    projectKey,
    botAccountId,
    fetched.issueTypes,
    teamManaged,
  );
  return { ok: true, ...result };
}
