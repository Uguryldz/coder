import { parseCommandFromComment, type CloudCommentCommand } from "@maestro/adapter-jira";
import { handleCommand, projectKeyOf, SIGNALS, SYSTEM_ACTOR, workflowIdFor, type ResolvedDeps } from "@maestro/bff";
import { ClarificationAnswerSignal, type TicketKey } from "@maestro/contracts";

/**
 * Reading Jira commands by polling, because the webhook cannot always reach us.
 *
 * `/approve`, `/reject <sebep>` and the rest arrive as ticket comments, and the
 * only path that reads them is `POST /webhooks/jira`. A deployment whose Jira
 * cannot reach that endpoint has a workflow engine that opens gates nobody can
 * close. Both drivers verify webhooks now (Cloud's `verifyWebhook`
 * stopped being a `CapabilityNotSupportedError` — see
 * `adapter-jira/src/cloud/work-port.ts`), so what is left is the deployment
 * where the call never ARRIVES: a Data Center inside a corporate network with
 * no outbound route to Maestro, or a Cloud site where nobody registered the
 * webhook.
 *
 * The pilot solved this the same way and for the same reason
 * (`apps/pilot/src/poll.ts`). This is that loop, feeding the command handler
 * the platform already has rather than a second copy of its rules.
 *
 * It lives beside the BFF rather than inside the workflow: an activity may not
 * poll (Temporal replays it), and a workflow that slept between polls would
 * bill a timer per ticket per interval.
 */

/**
 * Reading comments is not on `WorkPort`.
 *
 * The port carries what the WORKFLOW needs — a ticket, a comment to post, a
 * transition — and reading a comment thread is not part of that: the engine is
 * signalled, it does not look. The Cloud and Data Center drivers both offer it
 * on their concrete types, and the pilot reaches it the same way
 * (`apps/pilot/src/poll.ts` takes a `JiraCloudWorkPort`).
 *
 * Asking for the one method rather than the whole driver keeps this loop
 * testable and says exactly how much of Jira it touches.
 *
 * `parseCommandFromComment` is OPTIONAL and, when present, authoritative: a
 * comment resource does not look the same on the two products. Cloud (REST v3)
 * serves an ADF body and identifies people by `accountId`; Data Center (REST
 * v2) serves a wiki-markup STRING and has no `accountId` at all, only
 * `name`/`key`/`emailAddress`. Running a DC comment through the Cloud parser
 * therefore threw "comment has no identifiable author" on every real DC
 * thread. Each driver owns the reading of its own comments; the fallback below
 * is the Cloud parser, for a reader that offers none.
 */
export interface CommentReader {
  listComments(ticket: TicketKey): Promise<unknown[]>;
  parseCommandFromComment?(ticketKey: string, comment: unknown): CloudCommentCommand;
}

/**
 * Ticket'ın ŞU ANKİ hâlini okuyabilen sürücü — netleştirme yeniden girişinin
 * webhook'suz kanalı.
 *
 * Neden `WorkPort`'un tamamı değil de bu tek yöntem: yoklama döngüsü Jira'nın
 * ne kadarına dokunduğunu söylemek zorunda, ve `CommentReader` ile aynı
 * gerekçe burada da geçerli (test edilebilirlik + dürüst bir yüzey).
 *
 * Neden atama GEÇMİŞİ değil de mevcut atanan: Data Center sürücüsünde
 * `listAssigneeChanges` YOK (Cloud'da var — `cloud/work-port.ts`). Kullanıcının
 * kurulumu tamamen on-prem DC, yani geçmişe dayanan bir tasarım o kurulumda
 * hiç çalışmazdı. Mevcut atanan her iki üründe de okunabiliyor ve sorunun
 * cevabı için yeterli: "ticket şu an bot'ta mı?".
 */
export interface TicketReader {
  getTicket(key: TicketKey): Promise<{ assignee: string | null }>;
}

/** Bir sürücü ticket okuyabiliyor mu? `canReadComments` ile aynı desen. */
export function canReadTickets(driver: unknown): driver is TicketReader {
  return (
    typeof driver === "object" &&
    driver !== null &&
    typeof (driver as { getTicket?: unknown }).getTicket === "function"
  );
}

export interface PollerOptions {
  readonly deps: ResolvedDeps;
  /** The driver that can read a comment thread; see {@link CommentReader}. */
  readonly comments: CommentReader;
  /** Tickets to watch. Read fresh each round, so a new gate is picked up. */
  readonly openTickets: () => Promise<readonly TicketKey[]>;
  readonly intervalMs: number;
  readonly log?: (message: string) => void;
  /**
   * Ticket'ın mevcut atananını okuyan sürücü. Verilmezse netleştirme yeniden
   * girişi bu kurulumda YOKTUR — webhook'u çalışan bir kurulumda zaten
   * gerekmez, ve okuyucusu olmayan bir sürücüde sessizce yanlış yapmaktansa
   * hiç yapmamak doğru.
   */
  readonly tickets?: TicketReader;
  /**
   * Motorun çalıştığı hesabı ÇÖZEN işlev. `null` dönerse yeniden giriş bu turda
   * kapalı: karşılaştırılacak bir kimlik yoksa "bot'a atandı" ölçülemez.
   *
   * Sabit bir değer değil, HER TUR sorulan bir soru — çünkü kimlik boot'tan
   * SONRA öğrenilebiliyor: `MAESTRO_BOT_ACCOUNT_ID` boş bırakılan bir kurulumda
   * doğru cevap panelde bağlantı testi yapıldığı an ortaya çıkar. Boot'ta bir
   * kez okunsaydı, o testten sonra bile kanal yeniden başlatılana dek kapalı
   * kalırdı. Çözümün kuralı `apps/bff/src/bot-identity.ts`'te.
   */
  readonly botAccountId?: () => Promise<string | null>;
}

/**
 * Comments already answered.
 *
 * Keyed by author and timestamp, not by content: two people may write
 * `/approve` and the second one is a real second decision. Process-local by design — a restart
 * re-reads the window, and `decideGate` refuses a decision on a gate that is
 * already closed, so the worst case is a duplicate refusal in the log rather
 * than a duplicate approval.
 */
type Seen = Set<string>;

/**
 * Whether a work driver can read a comment thread at all.
 *
 * Same shape as the sweep's `canSearch`, and for the same reason: the
 * composition root used to cast `ports.work` to a comment reader with `as
 * unknown as`, which TypeScript accepts and the runtime does not.
 * `listComments` used to exist ONLY on the Jira Cloud driver — a Data Center
 * install had no such method, so every ticket threw once per interval and the
 * error was swallowed per-ticket. The visible effect is the one that matters in
 * a bank: `/approve` written on a ticket is never read, so an approval gate
 * waits forever and nobody can say why. The DC driver offers the reader now,
 * so this answers true for BOTH Jira drivers — but it stays a real check
 * rather than a cast, because Azure DevOps still has no work port at all and a
 * future driver may again have no thread to read.
 */
export function canReadComments(driver: unknown): driver is CommentReader {
  return (
    typeof driver === "object" &&
    driver !== null &&
    typeof (driver as { listComments?: unknown }).listComments === "function"
  );
}

/**
 * What one round did, counted rather than narrated.
 *
 * The poller used to log NOTHING at all: a deployment whose `/approve` was
 * never honoured could not tell, from the log, whether the loop was even
 * running — let alone whether Jira answered, whether the comment was read, or
 * why it was passed over. Every one of those is a different fix, and the
 * operator has only the container log to work from.
 *
 * A round prints ONE line built from these counters, never a line per ticket:
 * at a 60-second interval a per-ticket line is thousands of lines a day, and a
 * log nobody can read is the same as no log.
 */
interface RoundTally {
  tickets: number;
  comments: number;
  commands: number;
  /** Already answered in an earlier round — the de-dupe memory did its job. */
  duplicates: number;
  /** Looked like a command and could not be honoured (typo, missing reason). */
  malformed: number;
  /**
   * Refused because the comment was edited, or could not prove it was not.
   * Counted apart from every other skip because it is a SECURITY decision
   * (K-2/M32/M51), not a shrug — see the WARN in {@link pollTicket}.
   */
  editRefused: number;
  /** Tickets whose read threw — Jira unreachable, 401/403, an unknown shape. */
  failed: number;
  /** 2b'de bekleyip bot'a geri atandığı görülen ve uyandırılan koşular. */
  clarifyWakes: number;
}

function emptyTally(): RoundTally {
  return {
    tickets: 0,
    comments: 0,
    commands: 0,
    duplicates: 0,
    malformed: 0,
    editRefused: 0,
    failed: 0,
    clarifyWakes: 0,
  };
}

/**
 * Whether a per-ticket failure is worth its own line.
 *
 * A round that fails on EVERY ticket is one fact, not fifty, so the summary
 * carries the count and only the first few failures are named. The first one
 * is almost always the whole story (a wrong PAT answers 401 for every ticket),
 * and the cap keeps a Jira outage from filling the log.
 */
const MAX_NAMED_FAILURES = 3;

export function startJiraPoller(options: PollerOptions): { stop: () => void } {
  const seen: Seen = new Set();
  /**
   * Bu süreçte zaten uyandırılmış koşular.
   *
   * Sinyal idempotent DEĞİL diye değil (workflow `inbox.clarified`'ı bir kez
   * kaldırıyor, ikinci sinyal zararsız) — tur başına bir `getTicket` çağrısını
   * boşuna tekrarlamamak ve log'u aynı satırla doldurmamak için. Süreç-yerel:
   * yeniden başlatma pencereyi yeniden okur, ve o durumda en kötü ihtimal
   * kapanmış bir koşuya giden ve `no_run` dönen bir sinyaldir.
   */
  const wokeUp = new Set<string>();
  const log = options.log ?? ((message: string) => console.log(message));
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const tally = emptyTally();
    let tickets: readonly TicketKey[] = [];
    try {
      tickets = await options.openTickets();
    } catch (error) {
      log(`[yoklama] açık ticket listesi okunamadı: ${describeError(error)}`);
      return;
    }
    tally.tickets = tickets.length;

    let named = 0;
    for (const ticket of tickets) {
      if (stopped) return;
      try {
        await pollTicket(options.deps, options.comments, ticket, seen, log, tally);
        /**
         * Netleştirmeye yeniden giriş — webhook'suz kurulumun tek kanalı.
         *
         * Yorum okumasından AYRI tutuluyor ve onun hatasına takılmıyor: bir
         * ticket'ın yorum akışının okunamaması, o ticket'ın atanmasının da
         * okunamayacağı anlamına gelmez, ve 2b'de sonsuza dek bekleyen bir
         * koşuyu bir yorum hatası yüzünden kaybetmek en pahalı sessizlik olur.
         */
        await clarifyReentry(options, ticket, wokeUp, log, tally);
      } catch (error) {
        // One ticket's failure must not stop the others: a comment on a ticket
        // whose project was unbound mid-run would otherwise freeze every gate.
        tally.failed += 1;
        if (named < MAX_NAMED_FAILURES) {
          named += 1;
          // The ticket key and the driver's own message — never a token, never
          // the request headers. `describeError` is what keeps that promise.
          log(`[yoklama] ${ticket} okunamadı: ${describeError(error)}`);
        }
      }
    }

    if (stopped) return;
    /**
     * ONE line per round, printed even when the round found nothing.
     *
     * The empty round is the important one. "The poller is running and nobody
     * has approved anything" and "the poller is not running at all" are the two
     * states an operator with a stuck gate has to tell apart, and without this
     * line they look identical: silence. Same lesson the sweep already learned
     * (`jira-discovery.ts`).
     */
    log(
      `[yoklama] tur bitti: ${tally.tickets} ticket, ${tally.comments} yorum, ` +
        `${tally.commands} komut işlendi` +
        (tally.duplicates > 0 ? `, ${tally.duplicates} zaten görülmüş` : "") +
        (tally.malformed > 0 ? `, ${tally.malformed} hatalı komut` : "") +
        (tally.editRefused > 0 ? `, ${tally.editRefused} düzenlenmiş yorum reddedildi` : "") +
        (tally.clarifyWakes > 0 ? `, ${tally.clarifyWakes} netleştirme cevaplandı` : "") +
        (tally.failed > 0 ? `, ${tally.failed} ticket okunamadı` : ""),
    );
  };

  const timer = setInterval(() => void tick(), options.intervalMs);
  // Do not hold the process open for a reporting loop.
  timer.unref?.();
  void tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function pollTicket(
  deps: ResolvedDeps,
  reader: CommentReader,
  ticket: TicketKey,
  seen: Seen,
  log: (m: string) => void,
  tally: RoundTally,
): Promise<void> {
  const comments = await reader.listComments(ticket);
  tally.comments += comments.length;
  for (const comment of comments) {
    // The driver's own reader when it has one (DC's v2 shape differs from
    // Cloud's v3 in both body and identity — see `CommentReader`).
    let parsed: CloudCommentCommand;
    try {
      parsed =
        reader.parseCommandFromComment?.(ticket, comment) ?? parseCommandFromComment(ticket, comment);
    } catch (error) {
      /**
       * A comment this driver refuses to parse.
       *
       * The loudest case is the one the K-2 rule produces: a comment with no
       * `updated` timestamp cannot PROVE it was never edited, and an edited
       * comment must never carry a command (in Jira DC "Edit All Comments" is
       * a routine project-lead permission, so honouring one would let its
       * holder approve a gate AS SOMEONE ELSE — M32/M51). That is a security
       * refusal and it must not be silent: an operator whose `/approve` did
       * nothing needs to read the reason rather than guess at it.
       */
      tally.editRefused += 1;
      log(
        `[yoklama] ${ticket}: yorum komut üretmedi — ${describeError(error)} ` +
          "(düzenlenmiş yorum komut üretemez — görevler ayrılığı koruması)",
      );
      continue;
    }

    if (parsed.invalid !== null && parsed.invalid !== undefined) {
      /**
       * It LOOKED like a command and could not be honoured — a typo, a
       * `/reject` with no reason. Distinguished from "not a command at all",
       * which is the overwhelmingly common case and is counted silently: a
       * thread full of ordinary conversation must not fill the log.
       */
      tally.malformed += 1;
      log(`[yoklama] ${ticket}: hatalı komut — ${describeInvalid(parsed.invalid)}`);
      continue;
    }

    const { envelope } = parsed;
    if (envelope === null) continue;

    // Keyed by author AND timestamp: the comment id is not on the parsed
    // envelope, and two commands from one person at one instant is not a case
    // Jira produces. Content is deliberately not part of the key — a second
    // `/approve` from a second person is a second decision, not a repeat.
    const id = `${ticket}:${envelope.author}:${envelope.at}`;
    if (seen.has(id)) {
      tally.duplicates += 1;
      continue;
    }
    seen.add(id);

    // The author is the Jira account that wrote the comment, which is exactly
    // what the gate's membership check needs — no mapping from a local login
    // to a directory identity, because the decision was made IN the directory.
    const outcome = await handleCommand(deps, envelope);
    tally.commands += 1;
    /**
     * The one per-COMMAND line, and it is worth the space: a command is a rare
     * event (somebody typed it) and it is the exact event the operator is
     * looking for. The author is masked because a Data Center identity may BE
     * an e-mail address (`userIdOf` falls back to `emailAddress`), and an
     * e-mail address in a bank's log aggregator is personal data.
     */
    log(
      `[yoklama] ${ticket} ${envelope.command.name} (${maskAuthor(envelope.author)}) → ` +
        describeOutcome(outcome),
    );
  }
}

/**
 * 2b'de bekleyen bir koşuyu, ticket bot'a geri atanmışsa uyandır.
 *
 * ── Neden yoklamada da bir kanal gerekiyor ────────────────────────────────
 * Webhook yolu (`apps/bff/src/routes/webhooks.ts`) bu işi teslimat geldiğinde
 * yapıyor. Ama bu döngünün var olma sebebi tam olarak webhook'un ULAŞMADIĞI
 * kurulum: dışarı çıkışı olmayan bir kurumsal ağdaki Data Center. Orada
 * netleştirme cevabının hiçbir yolu olmazdı — koşu sonsuza dek 2b'de kalırdı.
 *
 * ── Yankı önlemenin bu kanaldaki hâli ─────────────────────────────────────
 * Webhook'ta üç katman var (kimlik / yön / zaman). Burada `actor` YOK: bir
 * ticket okuması onu kimin değiştirdiğini söylemez, yalnız şu anki hâlini
 * verir. Kalan iki katman bu kanalı yine de güvenli kılıyor:
 *
 *  · **Yön** — Maestro kendini hiçbir yerde bot'a ATAMIYOR. `reassignOnNeedInfo`
 *    ticket'ı reporter'a atar, yani bot'tan UZAĞA. Dolayısıyla "ticket şu an
 *    bot'ta" durumunu üretebilecek tek şey bir insanın hareketidir; eksik olan
 *    kimlik katmanının işini burada yönün kendisi görüyor.
 *  · **Zaman** — `awaitingClarificationSince`, sorunun sorulduğu andan önceki
 *    bir durumu cevap saymayı engelliyor. Bu, `reassignOnNeedInfo` KAPALI olan
 *    kurulumun tek koruması: orada ticket soru sorulurken de bot'ta kalır, ve
 *    zaman eşiği olmasa döngü daha ilk turunda kendi sorusunu cevaplardı.
 *
 * Hiçbir yolda fırlatmaz: yeniden giriş bir yan iş, ve bir tur onun yüzünden
 * yarıda kalmamalı. Tek istisna çağıranın kendi try/catch'i.
 */
async function clarifyReentry(
  options: PollerOptions,
  ticket: TicketKey,
  wokeUp: Set<string>,
  log: (m: string) => void,
  tally: RoundTally,
): Promise<void> {
  const reader = options.tickets;
  if (reader === undefined || wokeUp.has(ticket)) return;
  // Okuyucusu ya da karşılaştıracak kimliği olmayan kurulumda bu kanal yok.
  const bot = (await options.botAccountId?.().catch(() => null))?.trim() ?? "";
  if (bot === "") return;

  let state;
  try {
    state = await options.deps.runs.queryRunState(workflowIdFor(ticket));
  } catch {
    // Motor cevap vermedi. Bir sonraki tur yeniden sorar — bu döngünün
    // tamamı zaten tekrar eden bir sorudur.
    return;
  }
  if (state === null || state.step !== "2b") return;

  // ── zaman katmanı ────────────────────────────────────────────────────────
  const since = state.awaitingClarificationSince;
  if (since === undefined) return;
  const threshold = Date.parse(since);
  if (!Number.isFinite(threshold)) return;
  const now = options.deps.clock.now();
  if (now.getTime() < threshold) return;

  // ── yön katmanı ──────────────────────────────────────────────────────────
  let assignee: string | null;
  try {
    assignee = (await reader.getTicket(ticket)).assignee;
  } catch (error) {
    // Ticket okunamadı. Sayılıyor ve bir kez adlandırılıyor: bu kanalın
    // sessizce ölmesi, "düzelttim ama Maestro uyanmadı" şikâyetinin izsiz
    // kalması demek.
    log(`[yoklama] ${ticket}: netleştirme için ticket okunamadı — ${describeError(error)}`);
    return;
  }
  if (assignee === null || assignee.trim().toLowerCase() !== bot.toLowerCase()) return;

  const at = now.toISOString();
  const delivered = await options.deps.runs.signal(
    workflowIdFor(ticket),
    SIGNALS.clarificationAnswered,
    ClarificationAnswerSignal.parse({
      ticketKey: ticket,
      // Kim cevapladığını bu kanal BİLMİYOR (bir ticket okuması onu kimin
      // değiştirdiğini söylemez). Uydurulmuş bir isim yerine kanalın adı
      // yazılıyor: denetim zinciri "Jira'da yoklamayla görüldü" demeli,
      // olmayan bir kişiyi adlandırmamalı.
      answeredBy: "jira-poller",
      text: "Ticket Jira'da Maestro'ya geri atandı (yoklama).",
      at,
    }),
  );
  if (delivered !== "delivered") return;

  wokeUp.add(ticket);
  tally.clarifyWakes += 1;
  // Nadir ve tam olarak operatörün aradığı olay — kendi satırını hak ediyor.
  log(`[yoklama] ${ticket}: netleştirme cevaplandı (ticket Maestro'ya geri atandı)`);

  await options.deps.audit
    .append({
      actor: SYSTEM_ACTOR,
      action: "CLARIFICATION_ANSWERED",
      subject: ticket,
      at: now,
      meta: { source: "jira_poller", assignee },
    })
    // Denetim yazımı başarısız olsa bile koşu uyandı; bunu geri alamayız ve
    // turu de durdurmamalı.
    .catch((error: unknown) => {
      log(`[yoklama] ${ticket}: netleştirme denetim kaydı yazılamadı — ${describeError(error)}`);
    });
}

/**
 * An error as a log line: its name and message, capped.
 *
 * Never the error OBJECT and never its stack. A driver error may carry a
 * response body, and a response body may carry anything the server chose to
 * echo — including, on a misconfigured proxy, the `Authorization` header it
 * was sent. The cap is the second guard: an oversized body must not become an
 * unbounded log line.
 */
function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 200);
}

/** The refusal a malformed command produced — the catalog KEY, never the body. */
function describeInvalid(invalid: unknown): string {
  const record = invalid as { command?: unknown; messageKey?: unknown } | null;
  const command = typeof record?.command === "string" ? record.command : "?";
  const key = typeof record?.messageKey === "string" ? record.messageKey : "invalid";
  return `${command} (${key})`;
}

/**
 * A command's outcome as one short phrase.
 *
 * `JSON.stringify(outcome)` was the old line, and it is the wrong shape for a
 * log: a `/reject` outcome carries the operator's free-text REASON, which on a
 * bank's ticket routinely names a person or an account. The verdict and the
 * refusal code are what an operator needs; the reason is already on the ticket
 * and in the audit chain, where it belongs.
 */
function describeOutcome(outcome: unknown): string {
  const record = outcome as { accepted?: unknown; reason?: unknown } | null;
  if (record?.accepted === true) return "kabul edildi";
  const reason = typeof record?.reason === "string" ? record.reason : "reddedildi";
  return `kabul edilmedi (${reason})`;
}

/**
 * A comment author for the log.
 *
 * On Jira Cloud this is an opaque `accountId` and on Data Center a username —
 * both ordinary business data. But `userIdOf` falls back to `emailAddress`
 * when a DC user carries neither `name` nor `key`, so the value CAN be an
 * e-mail address, and that is personal data the platform masks everywhere else
 * (`packages/pii`). Masked only when it looks like one, so the common case
 * stays readable and an operator can still match the line to a person.
 */
export function maskAuthor(author: string): string {
  const at = author.indexOf("@");
  if (at <= 0) return author;
  const local = author.slice(0, at);
  const domain = author.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

/** Project key of a ticket, re-exported so callers filter without a second parser. */
export { projectKeyOf };
