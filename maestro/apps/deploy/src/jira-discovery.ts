import { type ResolvedDeps, runIntake } from "@maestro/bff";
import type { TicketKey } from "@maestro/contracts";
import { assigneeOf, labelsOf, nameOf } from "./work-events.js";

/**
 * Finding tickets by ASKING Jira, instead of waiting to be told.
 *
 * Until this existed a ticket could reach the platform by exactly two paths: a
 * Jira webhook, or a person typing `/ai-start`. Both are things somebody else
 * has to set up first — and when neither is in place the product looks broken
 * in the most confusing way possible: the panel is up, the connection tests
 * green, the rules are right, and no ticket ever appears. Measured on the
 * customer's own install, where the BFF had logged zero webhook deliveries
 * since the day it was built.
 *
 * A webhook is still the better path when it exists: it is instant and it costs
 * no polling. This is the path for everyone else — a Jira Cloud site whose
 * signature cannot be verified, a Data Center behind a firewall that cannot
 * call in, or an operator who simply has no admin rights on the Jira instance.
 *
 * It lives beside the BFF rather than inside the workflow for the reason the
 * comment poller gives: an activity may not poll (Temporal replays it), and a
 * workflow that slept between polls would bill a timer per ticket per interval.
 */

/**
 * Reading a search is not on `WorkPort`.
 *
 * The port carries what the WORKFLOW needs — a ticket, a comment, a transition
 * — and searching is not part of that: the engine is told which ticket to run,
 * it does not go looking. The Cloud driver offers it on its concrete type
 * (`searchIssues`), so asking for the one method keeps this loop testable and
 * states exactly how much of Jira it touches.
 */
export interface IssueSearcher {
  searchIssues(request: {
    jql: string;
    maxResults?: number;
    fields?: string[];
  }): Promise<{ issues: Array<{ key?: string }> }>;
}

/**
 * Whether a work driver can be swept at all.
 *
 * The composition root used to hand the sweep `ports.work as unknown as
 * IssueSearcher` — a cast TypeScript accepts and the runtime does not. Only the
 * Jira Cloud driver has `searchIssues`; on Data Center and on Azure DevOps the
 * loop threw `searchIssues is not a function` every single round, and the
 * panel's button surfaced it as a 500 with no explanation.
 *
 * Asking the object is honest where the cast was not: a driver either offers
 * the method or it does not, and a deployment that cannot sweep must SAY so
 * rather than fail once per interval.
 */
export function canSearch(driver: unknown): driver is IssueSearcher {
  return (
    typeof driver === "object" &&
    driver !== null &&
    typeof (driver as { searchIssues?: unknown }).searchIssues === "function"
  );
}

/** One listening rule, as much of it as discovery needs. */
export interface DiscoveryRule {
  readonly projectKey: string;
  readonly assigneeAccountId: string;
  readonly matchKind: "status" | "issuetype" | "assigned" | "label";
  readonly matchValue: string;
  /**
   * İZİN VERİLEN STATÜLER — sorguya HER ZAMAN giren kapı (0024).
   *
   * `matchKind` ne olursa olsun sorulur. Bunun sorguda olması, kararda
   * olmasından ayrı bir iş yapar: kapının BFF tarafı (`flow-decision.ts`
   * `statusGateOf`) yanlış statüdeki bir ticket'ı işlemez, ama o noktada ticket
   * ÇOKTAN OKUNMUŞTUR. Bu platformun servis hesabı ADMIN olduğu için okuma da
   * bir maliyet: bağlanmamış statüdeki ticket'ların hiç ÇEKİLMEMESİ gerekir —
   * `boundProjects` kapısının sorguyu projeye hapsetmesiyle aynı gerekçe, bir
   * kademe daha içeride.
   *
   * `null`/boş = "statü kısıtı yok" (0024 öncesi kurallar): sorguya statü
   * yan tümcesi eklenmez ve kural bugüne kadar nasıl arıyorsa öyle arar. Bu
   * bilinçli ve `flow-decision.ts` ile aynı karar — ama sessiz değil: turun
   * günlüğü bu kuralları ayrıca sayar ve adlandırır.
   */
  readonly allowedStatuses?: readonly string[] | null;
  readonly enabled: boolean;
}

export interface DiscoveryOptions {
  readonly deps: ResolvedDeps;
  /** The driver that can run a JQL search; see {@link IssueSearcher}. */
  readonly search: IssueSearcher;
  /** The listening rules, re-read each round so a new rule is picked up. */
  readonly rules: () => Promise<readonly DiscoveryRule[]>;
  /**
   * The project keys that are BOUND AND ACTIVE — the sweep's outer boundary.
   *
   * A listening rule names its own `projectKey` as free text. Nothing stops a
   * rule (a typo, a project that was later unbound, a row written by hand)
   * naming a project this deployment was never given. `runIntake` refuses such
   * a ticket as `unbound`, so no run starts — but by then the SEARCH has
   * already happened, and that is the part that must not.
   *
   * It matters here more than anywhere else in the platform: the service
   * account a bank runs Maestro as is routinely a Jira ADMIN, which sees every
   * project in the company. A rule pointing at an unbound project would send a
   * real query into a real project belonging to a team that has never heard of
   * Maestro, and pull their tickets back. The refusal one layer later does not
   * un-read them.
   *
   * So two gates, deliberately: this one keeps the QUERY inside the projects an
   * operator bound, and `runIntake`'s own binding check keeps the RUN inside
   * them. The first trusts the binding table over what a rule claims; the
   * second re-asks at the moment of acting. Neither alone is enough — the JQL
   * gate would be bypassed by any other entry point, and the intake gate lets
   * the read happen first.
   *
   * Optional so a composition root that has no binding source (and every
   * existing test) is unchanged; absent means "do not filter", which is the
   * behaviour before this existed. Wired in `apps/deploy/src/bin/bff.ts`, which
   * has the binding table.
   */
  readonly boundProjects?: () => Promise<readonly string[]>;
  /** Ticket keys the platform already knows about — never started twice. */
  readonly known: () => Promise<readonly TicketKey[]>;
  readonly intervalMs: number;
  /**
   * The interval as the OPERATOR set it, in SECONDS, re-read each tick.
   *
   * `intervalMs` is the boot-time default from the environment; this is the
   * live value from `jira.discover_minutes`. Read per round rather than at
   * start-up so tightening it in the panel takes effect on the next sweep
   * instead of the next restart — which on a bank's server is a change
   * request, not a click.
   *
   * Absent (or a read that fails) means "use the boot default": a parameter
   * store that is briefly unavailable must not stop the sweep.
   *
   * Seconds, not minutes: an operator who wants 80s must be able to say 80.
   */
  readonly intervalSeconds?: () => Promise<number | null>;
  /** Most tickets to take from one search. A guard, not a page size. */
  readonly maxPerRound?: number;
  readonly log?: (message: string) => void;
}

/**
 * What the last discovery round did — the panel's answer to "is this working?".
 *
 * An operator whose tickets are not arriving has no way to tell the difference
 * between "the sweep is off", "the sweep runs and finds nothing", and "the
 * sweep is failing" — and those three need three different fixes. The loop
 * knows; this is where it says so.
 *
 * Process-local on purpose: it describes THIS process's loop, and a second
 * replica's rounds are not this one's to report.
 */
export interface DiscoveryStatus {
  /** Whether a sweep is configured at all. */
  readonly enabled: boolean;
  readonly intervalMs: number;
  /** ISO timestamp of the last completed round; null before the first. */
  readonly lastRunAt: string | null;
  /** Tickets taken in the last round. */
  readonly lastStarted: number;
  /** Rules the last round searched with — zero means nothing to look for. */
  readonly rulesSearched: number;
  /** The last round's failure, if it had one. */
  readonly lastError: string | null;
}

const status: { current: DiscoveryStatus } = {
  current: {
    enabled: false,
    intervalMs: 0,
    lastRunAt: null,
    lastStarted: 0,
    rulesSearched: 0,
    lastError: null,
  },
};

/** The last round's outcome, for the Studio screen. */
export function discoveryStatus(): DiscoveryStatus {
  return status.current;
}

/** How many tickets one round may start, unless the caller says otherwise. */
const DEFAULT_MAX_PER_ROUND = 20;

/**
 * The JQL a rule matches with.
 *
 * Every rule is anchored to its project AND to the bot's account, because that
 * pair is what "Maestro was given this ticket" means — the same pair the rule
 * itself is keyed on. Without the assignee clause a search would sweep up every
 * ticket in the project, including ones nobody meant to hand over.
 *
 * `assigned` is the wildcard rule: assignment alone is the trigger, so it adds
 * no third clause. The other three narrow it by status, issue type or label.
 *
 * Returns `null` for any rule that cannot be turned into a BOUNDED query — no
 * bot account, or a label rule with no label. The caller skips such a rule
 * loudly rather than searching: see the account comment below for why an
 * unbounded query on an admin service account is the dangerous answer.
 */
export function jqlFor(rule: DiscoveryRule): string | null {
  const quoted = (value: string): string => `"${value.replace(/"/gu, '\\"')}"`;
  /**
   * The assignee is matched as an ACCOUNT ID, not as a quoted name.
   *
   * Measured against the live site: `assignee = "712020:b836…"` returns
   * nothing. Jira Cloud reads a quoted value as a display name or e-mail and
   * an account id is neither, so every sweep came back empty while the panel
   * reported six rules searched and zero tickets taken — the most misleading
   * shape a failure can have, because nothing errors.
   *
   * The documented form for an id is bare, and Jira's own docs recommend
   * `assignee in (id)` for account ids specifically.
   */
  const account = rule.assigneeAccountId.replace(/[^A-Za-z0-9:._-]/gu, "");

  /**
   * NO BOT ACCOUNT, NO SEARCH — the sweep's fail-closed boundary.
   *
   * `flow-decision.ts` reads an EMPTY `assigneeAccountId` as "whoever the
   * ticket is assigned to": a deliberate wildcard, and a safe one there,
   * because that code only ever CLASSIFIES a ticket somebody already handed to
   * the platform. Here the same emptiness would mean something entirely
   * different — it would decide which tickets to go and FETCH.
   *
   * The old line pasted the empty value in regardless and produced
   * `project = "OPS" AND assignee in ()`. That is malformed JQL, so Jira
   * answered 400, and the round's own catch logged it once per interval and
   * moved on: a rule that silently swept NOTHING, forever, looking exactly like
   * a rule that swept and found nothing.
   *
   * The service account this platform runs as is routinely a Jira ADMIN, and an
   * admin sees every project in the bank. So the failure mode on the other side
   * of one small JQL edit is not "no tickets" but "every ticket": drop the
   * clause and the sweep starts runs on, and comments onto, tickets belonging
   * to teams who have never heard of Maestro. Refusing to build a query at all
   * is the only safe answer, and returning `null` says so in the type — a
   * caller cannot forget to check a string that is not there.
   */
  if (account.length === 0) return null;

  /**
   * STATÜ YAN TÜMCESİ, TETİKLEME TİPİNDEN BAĞIMSIZ (0024).
   *
   * `base`'e ekleniyor, yani `assigned`/`issuetype`/`label` kuralları da statüyle
   * daralıyor — daha önce yalnızca `matchKind = "status"` kuralında vardı ve o
   * da bunun ALTERNATİFİYDİ. `status in (…)` çoklu değeri Jira'nın kendi
   * belgelediği biçim; tek elemanlı liste de aynı yoldan geçer, böylece "bir
   * statü" ile "iki statü" arasında iki ayrı gramer olmaz.
   *
   * Kısıtsız kuralda (`null`/boş) hiç eklenmez: boş bir `status in ()` malformed
   * JQL'dir ve Jira 400 döner — yani tur sessizce hiçbir şey aramaz, ki bu tam
   * olarak `jqlFor`'un var olma sebebi olan sessiz-sonsuz hatadır.
   */
  const statuses = (rule.allowedStatuses ?? [])
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const gate = statuses.length === 0 ? "" : ` AND status in (${statuses.map(quoted).join(", ")})`;

  const base = `project = ${quoted(rule.projectKey)} AND assignee in (${account})${gate}`;
  if (rule.matchKind === "status") return `${base} AND status = ${quoted(rule.matchValue)}`;
  if (rule.matchKind === "issuetype") return `${base} AND issuetype = ${quoted(rule.matchValue)}`;
  /**
   * A LABEL rule (0023) — the opt-in label, now a rule kind instead of a
   * project-wide gate.
   *
   * `labels = "x"` is the documented JQL form and it is a MEMBERSHIP test in
   * Jira, not an equality one: it matches an issue that carries `x` among any
   * number of labels, which is exactly what `flow-decision.ts` does on the
   * other side. The two must agree or a ticket the sweep fetches would then be
   * classified as matching no rule.
   *
   * An EMPTY value would produce `labels = ""`, which Jira rejects — and a
   * rejected query is the silent-forever failure this function exists to
   * prevent. The write path already refuses an empty `matchValue` (min(1)), but
   * this is the fail-closed boundary and it does not trust a caller: a rule with
   * nothing to look for gets no query at all, same as a rule with no bot
   * account.
   */
  if (rule.matchKind === "label") {
    const label = rule.matchValue.trim();
    if (label.length === 0) return null;
    return `${base} AND labels = ${quoted(label)}`;
  }
  return base;
}

/**
 * One discovery round: ask Jira what it has, start what is new.
 *
 * Returns the keys it started, so a caller (and the tests) can see the round's
 * effect without reading the log.
 */
export async function discoverOnce(options: DiscoveryOptions): Promise<readonly TicketKey[]> {
  const log = options.log ?? ((message: string): void => console.log(message));
  const cap = options.maxPerRound ?? DEFAULT_MAX_PER_ROUND;

  let rules: readonly DiscoveryRule[];
  try {
    rules = (await options.rules()).filter((rule) => rule.enabled);
  } catch (error) {
    log(`[keşif] dinleme kuralları okunamadı: ${String(error)}`);
    record({ lastError: String(error), rulesSearched: 0, lastStarted: 0 });
    return [];
  }
  if (rules.length === 0) {
    // Zero rules is a real, reportable state — not a failure. The panel says
    // "nothing to look for" rather than leaving the operator to guess, and so
    // does the log: silence here would read as a sweep that is not running.
    log("[keşif] tur bitti: açık dinleme kuralı yok, aranacak bir şey yok");
    record({ lastError: null, rulesSearched: 0, lastStarted: 0 });
    return [];
  }

  /**
   * BAĞLI OLMAYAN PROJEYE SORGU GİTMEZ — kapsamın dış sınırı.
   *
   * Kuralın `projectKey`'i serbest metin; bağlantı tablosu ise operatörün
   * gerçekten "bu projeyi Maestro'ya verdim" dediği yer. Çeliştiklerinde
   * bağlantı tablosu kazanır.
   *
   * FAIL-CLOSED, İKİ YÖNDE. Bağlı proje listesi OKUNAMAZSA tur, "süz" ile
   * "süzme" arasında ikincisini seçemez: süzmemek, admin bir servis hesabıyla
   * bankanın her projesine sorgu göndermek demektir. Bu yüzden okuma hatası
   * turu DURDURUR — ve sebebi panele de log'a da yazar; sessizce geniş
   * taramaktansa geçici olarak hiç taramamak doğru cevaptır.
   *
   * Kaynak hiç verilmemişse (eski bir bileşim kökü, testler) süzme yapılmaz:
   * bu, bu kapı var olmadan önceki davranıştır ve `runIntake`'in kendi
   * bağlantı kontrolü orada da yerindedir.
   */
  if (options.boundProjects !== undefined) {
    let bound: ReadonlySet<string>;
    try {
      bound = new Set(await options.boundProjects());
    } catch (error) {
      log(
        `[keşif] bağlı proje listesi okunamadı, tur ATLANDI: ${String(error)} — ` +
          "süzemediğimiz bir turda arama, bağlanmamış projelere de giderdi.",
      );
      record({ lastError: String(error), rulesSearched: 0, lastStarted: 0 });
      return [];
    }
    const inScope = rules.filter((rule) => bound.has(rule.projectKey));
    const dropped = rules.length - inScope.length;
    if (dropped > 0) {
      // Loudly: a rule that never runs because its project is not bound is a
      // misconfiguration an admin can fix in the panel, and a sweep that
      // ignored it in silence is how "kuralımı yazdım, hiçbir şey olmuyor"
      // becomes unanswerable.
      const names = [...new Set(rules.filter((r) => !bound.has(r.projectKey)).map((r) => r.projectKey))];
      log(
        `[keşif] ${dropped} kural atlandı: ${names.join(", ")} projesi bağlı değil (ya da duraklatıldı). ` +
          "Panelde projeyi bağlayın ya da kuralı silin.",
      );
    }
    rules = inScope;
    if (rules.length === 0) {
      log("[keşif] tur bitti: açık kuralların hiçbiri bağlı bir projeye ait değil");
      record({ lastError: null, rulesSearched: 0, lastStarted: 0 });
      return [];
    }
  }

  const known = new Set<string>(await options.known().catch(() => []));
  const started: TicketKey[] = [];
  // Deduped across rules: several rules routinely match one ticket (an
  // `assigned` wildcard beside a per-issuetype rule), and starting it twice
  // would be two runs for one piece of work.
  const seenThisRound = new Set<string>();
  /** Keys Jira returned this round, before the already-known filter. */
  let scanned = 0;
  /** Rules that could not be turned into a bounded query — see `jqlFor`. */
  let skippedRules = 0;

  for (const rule of rules) {
    if (started.length >= cap) break;

    /**
     * A rule that cannot be turned into a BOUNDED query is skipped, loudly.
     *
     * `jqlFor` answers null only for a rule with no bot account, and the reason
     * that must not become a search is written there. It must not become
     * SILENCE either: this is a misconfigured rule an admin can fix in the
     * panel, and the sweep quietly ignoring it forever is how "my rule does
     * nothing" becomes unanswerable.
     */
    const jql = jqlFor(rule);
    if (jql === null) {
      skippedRules += 1;
      log(
        `[keşif] ${rule.projectKey}/${rule.matchKind}=${rule.matchValue}: kuralda bot hesabı yok, ` +
          "aranmadı — hesapsız bir arama projedeki HERKESİN ticket'ını kapsardı. " +
          "Panelde Dinleme Kuralları'ndan kurala Maestro bot hesabını yazın.",
      );
      continue;
    }

    let issues: readonly unknown[];
    try {
      const page = await options.search.searchIssues({
        jql,
        maxResults: cap,
        /**
         * THE FOUR CLASSIFYING FIELDS, ASKED FOR IN THE SEARCH ITSELF.
         *
         * This asked for `["key"]` alone, on the reasoning that a key is all
         * the loop needs. It was not: the loop handed `runIntake` a bare key,
         * `flow-decision.ts` compared every rule against four nulls, NOTHING
         * matched, and the ticket the sweep had just found BECAUSE of a status
         * rule ran under the deployment default instead — losing that rule's
         * flow and its whole status map, and on an analysis-only binding being
         * refused outright as `no_application`. Measured on the bank's install:
         * the sweep worked, the panel reported tickets taken, and the operator
         * saw "ticket geliyor ama ajan çalışmıyor".
         *
         * The webhook path never had this problem because a delivery carries
         * these fields. Asking the SEARCH for them costs nothing extra — one
         * query either way, no per-ticket `getTicket` round-trip — and makes
         * the two entry points describe a ticket IDENTICALLY, which is the only
         * way all four trigger kinds can behave the same on both.
         *
         * Reading them beats inferring them from the query that found the
         * ticket. The inference is usually right (a `status` rule's hits do
         * carry that status) and still the wrong instinct: it puts a value Jira
         * never sent into the decision and into the audit entry that has to
         * answer "why did this ticket run this flow?" months later, and it goes
         * quietly wrong the moment a ticket moves between the search and the
         * intake.
         *
         * Still NOT the ticket text: `summary`/`description` stay unrequested,
         * so this path holds no ticket content — the original comment's real
         * concern, and it survives intact.
         */
        fields: ["status", "issuetype", "assignee", "labels"],
      });
      issues = page.issues;
      scanned += issues.length;
    } catch (error) {
      // One rule's failure must not stop the others: a project whose
      // permissions changed would otherwise freeze discovery for every project.
      log(`[keşif] ${rule.projectKey}/${rule.matchValue}: ${String(error)}`);
      continue;
    }

    for (const issue of issues) {
      if (started.length >= cap) break;
      // An issue with no key is nothing this loop can act on. Jira does not
      // send such a row; skipping rather than throwing keeps one odd payload
      // from ending a round that has other tickets in it.
      const key = issueKeyOf(issue);
      if (key === null) continue;
      if (known.has(key) || seenThisRound.has(key)) continue;
      seenThisRound.add(key);

      /**
       * THE TICKET IS DESCRIBED TO INTAKE, not just named.
       *
       * The sweep used to pass a bare ticket key. `runIntake` then re-decided
       * the flow with every classifying field `null`, so `flow-decision.ts`
       * matched NO rule and the ticket the sweep had just found BECAUSE of a
       * rule ran as if that rule did not exist. The fields come from the search
       * page itself (`classifyingFieldsOf`) — the same document a webhook
       * delivers, read with the same three readers.
       *
       * `explicit: true` is kept, though nothing branches on it since the
       * project-wide opt-in gate was retired (`jira-intake.ts`): a rule IS the
       * human decision, and the flag still says so to any future reader.
       */
      const outcome = await runIntake(options.deps, {
        ticket: key as TicketKey,
        actor: "maestro-worker",
        explicit: true,
        ...classifyingFieldsOf(issue),
      }).catch((error: unknown) => ({ accepted: false as const, reason: String(error) }));

      if (outcome.accepted) {
        started.push(key as TicketKey);
        log(`[keşif] ${key} alındı (${rule.projectKey}/${rule.matchKind}=${rule.matchValue})`);
      } else {
        // Not an error: a refusal is usually a kill switch or a project whose
        // binding was paused, and both are states an operator chose.
        log(`[keşif] ${key} alınmadı: ${outcome.reason}`);
      }
    }
  }
  /**
   * Every round says what it did, including the empty ones.
   *
   * Measured on the live install: a healthy sweep that found nothing printed
   * NOTHING, so "the sweep is running and there is no new ticket" and "the
   * sweep never ran" looked identical in the log — and the operator whose
   * tickets are not arriving cannot tell those two apart, which is the whole
   * question they are asking. The status endpoint knows, but it needs a
   * session; the log is what an operator reads first.
   */
  log(
    `[keşif] tur bitti: ${rules.length - skippedRules} kural arandı, ${started.length} ticket alındı` +
      `${scanned === 0 ? "" : `, ${scanned} eşleşme görüldü`}` +
      // Counted in the summary too, not only in the per-rule line above: an
      // operator scanning one line per round must see that some rules were
      // never searched at all.
      `${skippedRules === 0 ? "" : `, ${skippedRules} kural bot hesabı olmadığı için atlandı`}`,
  );
  record({ lastError: null, rulesSearched: rules.length - skippedRules, lastStarted: started.length });
  return started;
}

/**
 * The issue's key, or `null` when the row does not carry one.
 *
 * Read defensively for the same reason the field readers are: this is an
 * untyped document off the wire, and a row without a key is nothing the loop
 * can act on. Jira does not send one — but a `null` here costs a skipped row,
 * while a throw would end a round that still has other tickets in it.
 */
function issueKeyOf(issue: unknown): string | null {
  if (typeof issue !== "object" || issue === null) return null;
  const key = (issue as { key?: unknown }).key;
  return typeof key === "string" && key.trim() !== "" ? key : null;
}

/**
 * The four classifying fields, READ off the search result.
 *
 * The same three readers the webhook path uses (`work-events.ts`), shared on
 * purpose: a delivery and a search hit are the same Jira `issue` document, and
 * two hand-rolled grammars for one document is precisely how two entry points
 * end up classifying the same ticket differently — the failure this change
 * exists to undo.
 *
 * Every field is OMITTED when the payload did not carry it, never filled with a
 * guess. `IntakeRequest` reads absence as "not known here", which matches no
 * rule: the fail-closed answer, and the one that keeps the audit entry honest
 * about what Jira actually said.
 *
 * Exported so a test can drive a real Jira `issue` document straight into
 * `flow-decision.ts` and assert the round trip — the sweep reads the ticket,
 * and what it read matches the very rule that found it. The bug this replaces
 * was invisible to every test that only checked the JQL, because the JQL was
 * already right.
 */
export function classifyingFieldsOf(issue: unknown): {
  status?: string;
  issueType?: string;
  assignee?: string;
  labels?: readonly string[];
} {
  const status = nameOf(issue, "status");
  const issueType = nameOf(issue, "issuetype");
  const assignee = assigneeOf(issue);
  const labels = labelsOf(issue);
  return {
    ...(status === null ? {} : { status }),
    ...(issueType === null ? {} : { issueType }),
    ...(assignee === null ? {} : { assignee }),
    ...(labels === null ? {} : { labels }),
  };
}

/** Stamp the round's outcome onto the status the panel reads. */
function record(round: Pick<DiscoveryStatus, "lastError" | "rulesSearched" | "lastStarted">): void {
  status.current = {
    ...status.current,
    ...round,
    lastRunAt: new Date().toISOString(),
  };
}

/**
 * Poll Jira for new tickets until stopped.
 *
 * Off unless the caller passes an interval, the same way the comment poller is:
 * an installation whose webhook works does not need this, and two paths
 * starting the same ticket is the one outcome worth avoiding. `runIntake`
 * itself is idempotent per ticket, so an overlap is safe — but paying for it
 * every round is not.
 */
export function startJiraDiscovery(options: DiscoveryOptions): { stop: () => void } {
  status.current = { ...status.current, enabled: true, intervalMs: options.intervalMs };
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    await discoverOnce(options).catch((error: unknown) => {
      (options.log ?? console.log)(`[keşif] tur başarısız: ${String(error)}`);
      return [];
    });
  };
  /**
   * Rescheduled after every round rather than a fixed `setInterval`, because
   * the operator can change the interval while it runs. A fixed timer would
   * keep the interval it was created with until the process restarted.
   */
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (ms: number): void => {
    timer = setTimeout(() => void loop(), ms);
    timer.unref?.();
  };
  const loop = async (): Promise<void> => {
    if (stopped) return;
    await tick();
    if (stopped) return;
    let ms = options.intervalMs;
    try {
      const seconds = await options.intervalSeconds?.();
      // 0 means "off": stop rescheduling rather than spinning on a zero delay.
      if (seconds !== null && seconds !== undefined) {
        if (seconds <= 0) {
          (options.log ?? console.log)("[keşif] tarama panelden kapatıldı");
          status.current = { ...status.current, enabled: false };
          return;
        }
        ms = seconds * 1_000;
        status.current = { ...status.current, enabled: true, intervalMs: ms };
      }
    } catch {
      // A parameter store that is briefly down must not stop the sweep.
    }
    schedule(ms);
  };
  void loop();
  return {
    stop: (): void => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
