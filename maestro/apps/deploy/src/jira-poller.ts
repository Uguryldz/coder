import { parseCommandFromComment, type CloudCommentCommand } from "@maestro/adapter-jira";
import {
  handleCommand,
  projectKeyOf,
  SIGNALS,
  SYSTEM_ACTOR,
  tryGateStatusDecision,
  workflowIdFor,
  type ResolvedDeps,
} from "@maestro/bff";
import { ClarificationAnswerSignal, type TicketKey } from "@maestro/contracts";
import type { JiraWorkflowReader } from "@maestro/bff";

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

/**
 * Ticket'ın ŞU ANKİ statü ADINI okuyabilen sürücü — kapı kararının webhook'suz
 * kanalı.
 *
 * Neden `getTicket` yetmiyor: donmuş `TicketSnapshot` bir statü alanı taşımıyor
 * (`packages/contracts/src/ticket.ts`), ve o şemayı yalnız bunun için
 * genişletmek ondan beslenen her yazıcıya ve doğrulayıcıya dokunmak demekti.
 * Her iki Jira sürücüsü `readCurrentStatus`u ayrı bir yetenek olarak sunuyor —
 * `transitionToStatus`'un zaten yaptığı `fields=status` okumasının aynısı.
 *
 * `null` dönmesi "site statü söylemedi" demek ve karar üretmez: bilinmeyen bir
 * statüden kapı kararı çıkarmamak bu kanalın fail-closed yönü.
 */
export interface TicketStatusReader {
  readCurrentStatus(key: TicketKey): Promise<string | null>;
  /**
   * Statü değişimleri — KİM, ne zaman, nereye. Kapı kararının bu kanalda
   * yetkiyle verilebilmesinin tek yolu.
   *
   * `decideGate` GRUP ÜYELİĞİ soruyor (M32/M35), ve üyelik ancak kararı VERENİ
   * adlandırabildiğimizde ölçülebilir. Ticket'ın şu anki statüsü onu kimin
   * oraya taşıdığını söylemez; changelog söyler. Bu okuyucu olmadan yoklama
   * kanalı imzasız kalırdı ve hiçbir kapı kararı taşıyamazdı.
   */
  listStatusChanges(
    key: TicketKey,
  ): Promise<ReadonlyArray<{ actorAccountId: string; toStatus: string | null; at: string }>>;
}

/**
 * Bir sürücü statü değişimlerini okuyabiliyor mu? `canReadTickets` ile aynı
 * desen — ve İKİ yöntemi birden soruyor, çünkü kanal ikisine de muhtaç:
 * `readCurrentStatus` "ticket şu an nerede", `listStatusChanges` "oraya kim
 * taşıdı". Birinin varlığından diğerini VARSAYMAK, tam olarak `as unknown as`
 * kastının yaptığı hata olurdu.
 */
export function canReadStatuses(driver: unknown): driver is TicketStatusReader {
  return (
    typeof driver === "object" &&
    driver !== null &&
    typeof (driver as { readCurrentStatus?: unknown }).readCurrentStatus === "function" &&
    typeof (driver as { listStatusChanges?: unknown }).listStatusChanges === "function"
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
   * Ticket'ın statüsünü okuyan sürücü — KAPI KARARININ statüyle verilmesi
   * (`gate-status-reentry.ts`). Verilmezse bu kanal bu kurulumda YOKTUR ve
   * `/approve` yorumu tek yol olarak kalır; okuyucusu olmayan bir sürücüde
   * sessizce yanlış yapmaktansa hiç yapmamak doğru — `tickets` ile aynı duruş.
   */
  readonly statuses?: TicketStatusReader;
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
  /** Statü değişiminden okunup KAPATILAN kapılar (onay ya da geri gönderme). */
  gateDecisions: number;
  /**
   * Statü kararı görüldü ama kapı kapanmadı — üyelik reddi, arada kapanmış
   * kapı, teslim edilemeyen sinyal. `gateDecisions`ten AYRI sayılıyor: bu tam
   * olarak "taşıdım ama bir şey olmadı" şikâyetinin sayacı, ve sıfırla
   * karıştırılmamalı.
   */
  gateRefused: number;
  /**
   * KAPIDA BEKLEYEN ama statü kanalı bu projede HİÇ YAPILANDIRILMAMIŞ koşular.
   *
   * `gateRefused`ten ayrı sayılıyor ve ayrı olması bu sayacın tüm sebebi: orası
   * "karar görüldü, kapı kapanmadı", burası "karar HİÇ SORULMADI". Operatör
   * ticket'ı analize geri taşıyıp hiçbir şey olmadığını gördüğünde iki durumun
   * çaresi taban tabana zıt — biri yetki/zamanlama, diğeri panelde iki alanın
   * boş bırakılmış olması — ve ikisi de sıfır sayılırsa log ikisini de
   * "yoklama çalışıyor, kimse bir şey yapmadı" diye gösterir.
   *
   * `gateApproveStatus`/`gateReturnStatus` 1.0.20'de GELDİ, yani yükseltilen
   * her kurulumda bu alanlar BOŞ başlıyor ve kanal sessizce kapalı. Sessizliğin
   * bedelini 0024 zaten ödedi: çalışmayan değil, GÖRÜNMEYEN kusur pahalıdır.
   */
  gateUnconfigured: number;
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
    gateDecisions: 0,
    gateRefused: 0,
    gateUnconfigured: 0,
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
        /**
         * Kapı kararının statüyle verilmesi — netleştirme yeniden girişinden
         * AYRI tutuluyor ve onun hatasına takılmıyor, aynı gerekçeyle: bir
         * ticket'ın 2b okumasının patlaması, o ticket'ın kapı statüsünün de
         * okunamayacağı anlamına gelmez, ve kapıda haftalarca bekleyen bir
         * koşuyu başka bir kanalın hatası yüzünden kaybetmek en pahalı
         * sessizlik olur.
         */
        await gateStatusRound(options, ticket, log, tally);
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
        (tally.gateDecisions > 0 ? `, ${tally.gateDecisions} kapı statüyle kapandı` : "") +
        (tally.gateRefused > 0 ? `, ${tally.gateRefused} statü kararı kabul edilmedi` : "") +
        /**
         * Kapıda bekleyen bir koşu VAR ve statü kanalı kapalı — operatörün
         * "geri gönderdim, hiçbir şey olmadı" sorusunun cevabı bu satır.
         * ÇARESİYLE birlikte yazılıyor: sayı tek başına operatöre panelde
         * hangi iki alanı dolduracağını söylemez.
         */
        (tally.gateUnconfigured > 0
          ? `, ${tally.gateUnconfigured} kapı statü kanalı kapalı ` +
            "(Dinleme kuralında 'kapı onay/geri gönderme statüsü' boş — " +
            "doldurana kadar kapı yalnız /approve ve /reject yorumlarıyla kapanır)"
          : "") +
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
 * KAPI KARARININ STATÜDEN OKUNMASI — webhook'suz kurulumun tek kanalı.
 *
 * ── Neden yoklamada da bir kanal gerekiyor ────────────────────────────────
 * Webhook yolu (`apps/bff/src/routes/webhooks.ts`) bunu teslimat geldiğinde
 * yapıyor. Ama bu döngünün var olma sebebi tam olarak webhook'un ULAŞMADIĞI
 * kurulum: dışarı çıkışı olmayan kurumsal ağdaki Data Center. Orada operatörün
 * ticket'ı bir statüye taşıması hiçbir şey yapmazdı ve `/approve` tek yol
 * olarak kalırdı — ki bu görev tam olarak onu değiştirmek için var.
 *
 * ── EK MALİYET: KAPIDA BEKLEYEN TICKET BAŞINA BİR `fields=status` OKUMASI ──
 * Ve yalnız orada. Sıra bilinçli: önce koşu durumu MOTORDAN sorulur (ağ
 * çağrısı değil, aynı süreçte bir Temporal sorgusu), ve kapı açık değilse Jira
 * hiç aranmaz. Kapıda bekleyen koşu sayısı, açık koşuların küçük bir alt
 * kümesi — çoğu tur sıfır ek çağrıdır.
 *
 * `clarifyReentry` aynı sırayı izliyor ve aynı sebeple.
 *
 * ── YANKI KORUMASININ BU KANALDAKİ HÂLİ ───────────────────────────────────
 * Üç katmandan İKİSİ burada da tam güçte, biri eksik ve eksikliği taşınıyor:
 *
 *  · **Zaman** (`gateOpenedSince`) — `tryGateStatusDecision` içinde. Maestro
 *    kapıya girerken ticket'ı `onReview`e KENDİSİ taşıyor; o taşıma damganın
 *    GERİSİNDE kalır. Bu kanalın en kritik katmanı, çünkü kimlik yok.
 *  · **Yön** — statü, kuralın `gateApproveStatus`/`gateReturnStatus`
 *    alanlarından biri olmalı, ve o alanlar Maestro'nun kendi taşıdığı beş
 *    noktayla ÇAKIŞAMAZ (çakışırsa düşer). Yani bu kanalı açabilecek tek şey,
 *    Maestro'nun kendiliğinden asla üretmeyeceği bir statü.
 *  · **Kimlik** — YOK. Bir ticket okuması onu kimin taşıdığını söylemez.
 *    `clarify-reentry.ts`'in yoklama tarafı aynı ödünü verdi, aynı gerekçeyle.
 *
 * ── VE KİMLİĞİN EKSİKLİĞİNİN İKİNCİ BİR BEDELİ VAR: ÜYELİK ────────────────
 * `decideGate` GRUP ÜYELİĞİ sorar (M32/M35) — statü değiştirmek yetkiyi
 * atlamanın yolu değildir. Bu kanalda karar vereni adlandıramadığımız için
 * üyelik de ölçülemez, ve ölçülemeyen bir yetkiyle kapı açmak, kapının var
 * olma sebebini ortadan kaldırır.
 *
 * Seçilen davranış: bu kanal YALNIZ "analize geri gönder" kararını taşır,
 * ONAYI TAŞIMAZ. Gerekçe asimetriktir ve bilerek öyle:
 *
 *   · ONAY işi İLERLETİR — analizin kabul edildiğini söyler ve akışı bir
 *     sonraki aşamaya geçirir. İmzasız bir onay, SoD'nin (M32) tam olarak
 *     engellemek için var olduğu şeydir. Bu kanalda onay YOK; operatör
 *     `/approve` yazar, ve `decideGate` onun Jira hesabını üyelikle ölçer.
 *   · GERİ GÖNDERME işi İLERLETMEZ — analizi yeniden yazdırır ve kapıyı
 *     yeniden açar. En kötü ihtimalle yetkisiz biri bir analiz turu daha
 *     harcatır; kimse hiçbir şeyi onaylamış olmaz. `canCloseGate`in `reject`i
 *     yetki kontrolünden muaf tutmasının gerekçesinin aynısı, bir kademe
 *     yumuşağı.
 *
 * Bu kısıtlama SESSİZ DEĞİL: onay statüsü yapılandırılmış ama bu kanalda
 * taşınamıyorsa, tur günlüğüne kendi satırı düşer — operatör "onay statüsüne
 * taşıdım, hiçbir şey olmadı" dediğinde cevabı log'da bulur.
 *
 * Hiçbir yolda FIRLATMAZ: kapı kanalı bir yan iş, ve bir tur onun yüzünden
 * yarıda kalmamalı.
 */
async function gateStatusRound(
  options: PollerOptions,
  ticket: TicketKey,
  log: (m: string) => void,
  tally: RoundTally,
): Promise<void> {
  const reader = options.statuses;
  if (reader === undefined) return;
  /**
   * Bot kimliği olmadan KİMLİK katmanı kurulamaz, ve bu kanalda o katman
   * vazgeçilebilir değil: Maestro'nun kendi `onReview` taşıması changelog'a
   * bot adıyla düşer, ve onu ayıklayamazsak kapı kendi açılışıyla kendini
   * kapatır. Netleştirme kanalının `botAccountId` boşken kapanmasıyla aynı
   * duruş, aynı gerekçe.
   */
  const bot = (await options.botAccountId?.().catch(() => null))?.trim() ?? "";
  if (bot === "") return;

  // Önce motor: kapı açık değilse Jira hiç aranmaz. `gateOpenedSince` kapının
  // açık olmasının KENDİSİ — `gate-loop.ts` onu açılışta atıyor, kapanışta
  // siliyor — yani `status === "gate"`ten daha keskin: 2b beklemesi de kendini
  // `gate` diye raporlar ve o onaylanacak bir şey değildir.
  let state;
  try {
    state = await options.deps.runs.queryRunState(workflowIdFor(ticket));
  } catch {
    return;
  }
  if (state === null || state.gateOpenedSince === undefined) return;

  /**
   * SON STATÜ TAŞIMASI — ve onu kimin yaptığı.
   *
   * `readCurrentStatus` değil `listStatusChanges` okunuyor, ve fark bu kanalın
   * ayakta durmasını sağlayan şey: "ticket şu an X'te" bir karar DEĞİL, çünkü
   * kimin taşıdığını söylemez ve `decideGate` üyeliği ancak bir kişiye
   * sorabilir. Changelog'un son statü kaydı üç sorunun da cevabı: nereye, kim,
   * ne zaman.
   *
   * Boş changelog: ticket hiç taşınmamış — kapıda bekleyen bir koşu için bu
   * "operatör henüz bir şey yapmadı" demek, bir hata değil.
   */
  let last: { actorAccountId: string; toStatus: string | null; at: string } | undefined;
  try {
    const changes = await reader.listStatusChanges(ticket);
    last = changes.at(-1);
  } catch (error) {
    // Sayılıyor ve adlandırılıyor: bu kanalın sessizce ölmesi, "taşıdım ama
    // Maestro görmedi" şikâyetinin izsiz kalması demek.
    log(`[yoklama] ${ticket}: kapı statüsü okunamadı — ${describeError(error)}`);
    return;
  }
  if (last === undefined || last.toStatus === null || last.toStatus.trim() === "") return;
  const status = last.toStatus;

  /**
   * ZAMAN katmanı bu kanalda changelog KAYDININ zamanıyla ölçülüyor, turun
   * saatiyle değil — ve bu fark kritik.
   *
   * Yoklama 60 saniyede bir çalışıyor, yani "şimdi" her zaman hareketten
   * SONRADIR. Turun saatini kullansaydık, kapı açılmadan önce yapılmış bir
   * taşıma bile eşiği geçerdi: Maestro'nun kendi `onReview` hareketi bir
   * sonraki turda "operatör kararı" olarak okunurdu. Kaydın kendi zamanı,
   * webhook yolunun teslimat zamanının bu kanaldaki karşılığı.
   *
   * Ayrıştırılamayan bir damga (site boş `created` gönderdi) fail-closed:
   * ölçülemeyen bir eşikle karar üretmek, eşiğin var olma sebebini ortadan
   * kaldırır.
   */
  const movedAt = Date.parse(last.at);
  if (!Number.isFinite(movedAt)) return;

  const outcome = await tryGateStatusDecision(
    options.deps,
    {
      ticket,
      status,
      /**
       * KİMLİK katmanı bu kanalda da TAM — changelog aktörü taşıyor.
       *
       * `clarify-reentry.ts`'in yoklama tarafı bu katmanı veremiyordu (bir
       * ticket okuması onu kimin değiştirdiğini söylemez) ve ödünü yön +
       * zamana yıkmıştı. Burada öyle bir ödün YOK ve olmamalı: kapı kararı
       * üyelik gerektiriyor, üyelik bir kişiye sorulur, ve kişiyi uydurmak
       * SoD'yi (M32) delmek olurdu.
       */
      identity: { actor: last.actorAccountId, bot },
      // Ve kimlik tam olduğu için bu kanal ONAYI da taşır.
      canApprove: true,
      observedAt: new Date(movedAt),
    },
    workflowIdFor(ticket),
  );
  if (outcome.kind !== "decided") {
    /**
     * Kanal bu projede HİÇ yapılandırılmamış. Ticket kapıda bekliyor, operatör
     * onu taşımış olabilir, ve `decideFromStatus` soracak bir statü adı
     * bulamadığı için sessizce çıkıyordu. Sayaç bu sessizliği kırar.
     *
     * Tur BAŞINA değil TICKET başına sayılıyor: aynı turda kapıda bekleyen üç
     * ticket varsa üçü de aynı boş eşlemeden etkileniyor, ve "3 koşu bu yüzden
     * bekliyor" cümlesi "1 kural eksik"ten daha çok şey söyler.
     */
    if (outcome.reason === "no_gate_statuses") tally.gateUnconfigured += 1;
    if (outcome.reason === "status_map_conflict") {
      log(
        `[yoklama] ${ticket}: kapı statüsü eşlemesi çakışık — ` +
          `${(outcome.conflicts ?? []).join("; ")} — bu karar statüyle verilemiyor`,
      );
    }
    /**
     * ── "KAYITLAR ATLANMASIN" ──────────────────────────────────────────────
     *
     * Ticket KAPIDA BEKLİYOR, operatör onu bir yere taşıdı, ve o statünün
     * kuralda tanımlı bir rolü yok. Eskiden bu sessizce düşüyordu ve operatörün
     * "taşıdım, hiçbir şey olmadı" sorusunun hiçbir yerde cevabı yoktu.
     *
     * Gürültü değil: buraya gelen hareket zaten dar bir elekten geçti — koşu
     * kapıda, hareket kapı açıldıktan sonra, ve aktör bot değil. Kapıda
     * beklemeyen ticket'lar bu fonksiyona hiç girmiyor.
     *
     * Kuralın TANIDIĞI noktalar satıra yazılıyor: operatör farkı bir bakışta
     * görsün diye. Boş liste "o karar bu kuralda hiç tanımlı değil" demek ve
     * öyle yazılıyor — boş bir tırnak, cevabı bulunmuş gibi görünürdü.
     */
    if (outcome.reason === "not_a_gate_status") {
      const known = outcome.known ?? { approve: [], return: [] };
      const say = (names: readonly string[]): string =>
        names.length === 0 ? "tanımsız" : names.join(", ");
      log(
        `[yoklama] ${ticket}: '${status.trim()}' statüsüne taşındı — bu kuralda tanımlı bir rol ` +
          `değil, yok sayıldı (onay: ${say(known.approve)} · geri gönderme: ${say(known.return)})`,
      );
    }
    /**
     * Onay statüsüne taşındı ama bu kanal onayı taşıyamıyor. Bugün yoklama
     * kanalı `canApprove: true` geçiyor (changelog aktörü veriyor), yani bu dal
     * ulaşılmaz — ama `canApprove` bir gün `false` dönerse bu sessizce bir
     * onayın yutulması demek olurdu, ve o tam olarak operatörün yasakladığı şey.
     */
    if (outcome.reason === "approval_needs_identity") {
      log(
        `[yoklama] ${ticket}: '${status.trim()}' onay statüsü — ama bu kanalda karar verenin ` +
          "kimliği okunamıyor, onay taşınamadı. Ticket'a \"/approve\" yazın.",
      );
    }
    return;
  }

  const verdict = outcome.decision === "approve" ? "onaylandı" : "analize geri gönderildi";
  if (outcome.result.ok) {
    tally.gateDecisions += 1;
    // Nadir ve tam olarak operatörün aradığı olay — kendi satırını hak ediyor.
    // Aktör MASKELİ: DC'de bir hesap adı e-posta OLABİLİR (`userIdOf`
    // `emailAddress`'e düşer) ve bankanın log toplayıcısında e-posta kişisel
    // veridir. Denetim zincirinde ham hâliyle duruyor, orası maskelenmez.
    log(
      `[yoklama] ${ticket}: kapı ${outcome.step} — statü '${status.trim()}' ile ${verdict} ` +
        `(${maskAuthor(last.actorAccountId)})`,
    );
    return;
  }
  tally.gateRefused += 1;
  log(
    `[yoklama] ${ticket}: kapı ${outcome.step} — statü '${status.trim()}' kararı kabul edilmedi ` +
      `(${outcome.result.reason})`,
  );
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

/**
 * Bir sürücü PROJE İŞ AKIŞINI okuyabiliyor mu (statüler + geçişler).
 *
 * `canReadStatuses` ile aynı desen ve aynı gerekçe: yeteneğin varlığı SORULUR,
 * varsayılmaz. `readProjectWorkflow` Jira Cloud sürücüsünde var, Data Center
 * sürücüsünde henüz yok — ve "yok" ile "bu projenin iş akışı yok" farklı iki
 * şey. Bağlanmamış bir kurulum uçtan 503 alır, boş bir sayfa değil.
 */
export function canReadWorkflow<T>(driver: unknown): driver is T & JiraWorkflowReader {
  return (
    typeof driver === "object" &&
    driver !== null &&
    typeof (driver as { readProjectWorkflow?: unknown }).readProjectWorkflow === "function"
  );
}
