import { type ResolvedDeps, runIntake } from "@maestro/bff";
import type { TicketKey } from "@maestro/contracts";
import { assigneeOf, idOf, labelsOf, nameOf } from "./work-events.js";

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

/**
 * Zaten koşusu olan bir ticket, koşunun NEREDE olduğuyla birlikte.
 *
 * `status` ve `step` serbest metin değil, koşunun kendi vokabüleri
 * (`WorkflowRunStatus` ve `StepId`) — ama burada `string` olarak alınıyor:
 * bu modül veritabanı satırını okumuyor, çağıran okuyor, ve daraltmak
 * `apps/deploy`'un `packages/contracts`'a bu uçta bağlanmasını gerektirirdi.
 */
export interface KnownRun {
  readonly ticket: TicketKey;
  /** Koşunun adımı (`StepId`), ör. "5". Bilinmiyorsa boş. */
  readonly step?: string;
  /** Koşunun durumu (`WorkflowRunStatus`), ör. "gate". Bilinmiyorsa boş. */
  readonly status?: string;
  /** Koşunun son güncellemesi. Bilinmiyorsa yok. */
  readonly updatedAt?: string | Date;
}

/**
 * Koşusu BİTMİŞ olduğu hâlde havuzda duran ticket: işlem yapıldı ama ticket
 * ileri ya da geri oynamadı. Operatörün kuralı "havuzda hiçbir zaman ticket
 * kalamaz"; bu yardımcı o kuralın ihlalini tanır. Kapıda bekleyen (`gate`) ya
 * da çalışan koşu ihlal değildir — işi bitmemiştir.
 */
const FINISHED_RUN_STATUSES: ReadonlySet<string> = new Set(["done", "fail", "failed", "handover", "cancelled"]);
/** Kaydı "hatalı" olan koşu — yürütme düştü; tarama onu yeniden alır. */
export function isFailedRun(run: KnownRun): boolean {
  const status = (run.status ?? "").trim();
  return status === "fail" || status === "failed";
}

/**
 * Yeniden başlatmanın SEBEBİ, operatörün diliyle.
 *
 * Üç hal üç ayrı cümle olmalı, çünkü operatörün yapacağı şey her birinde
 * farklı. Bir dönem üçü de "önceki koşu motorda bulunamadı" diyordu ve bu,
 * havuzda takılmış bir ticket için düpedüz yanlıştı: koşu bulunuyordu, bitmişti.
 */
function restartWhy(run: KnownRun, alive: ReadonlySet<string> | null): string {
  if (finishedButPooled(run)) {
    const durum = (run.status ?? "").trim();
    return durum === "done"
      ? "önceki koşu bitti ama ticket havuzda kaldı (statü eşlemesi ileri taşımadı ya da geri verildi)"
      : `önceki koşu ${durum} durumunda ve ticket havuzda kaldı`;
  }
  if (isFailedRun(run)) return "önceki koşunun kaydı hatalı";
  return alive === null ? "önceki koşu okunamadı" : "önceki koşu motorda bulunamadı";
}

export function finishedButPooled(run: KnownRun): boolean {
  return FINISHED_RUN_STATUSES.has((run.status ?? "").trim());
}

/**
 * MOTORDA YAŞAYAN KOŞULARIN ANAHTARLARI — turun "bu koşu ölmüş mü" ölçümü.
 *
 * ── Neden ticket BAŞINA sorgu değil ───────────────────────────────────────
 * `queryRunState` tek bir iş akışını sorar, ve havuzda yüz ticket varsa bu
 * her turda yüz gRPC çağrısı demek. Tarama beş dakikada bir koşuyor ve
 * `runIntake`in kendisi zaten Jira'ya gidiyor; oraya ticket başına bir de
 * Temporal turu eklemek, çözülen sorundan (durmayan robot) pahalı bir sorun
 * (motoru döven zamanlayıcı) üretirdi.
 *
 * Bunun yerine TEK bir toplu okuma: `RunGateway.list()` motorun tuttuğu
 * execution'ları bir sayfada verir, ve turun ihtiyacı olan tek şey o
 * sayfadaki ticket ANAHTARLARIDIR. `reconcileRunStatuses` (açılışta koşan
 * kıyas) tam olarak aynı deseni kullanıyor — aynı soruyu iki farklı maliyetle
 * sormamak için.
 *
 * ── FAIL-CLOSED: okunamayan motor "her koşu ölü" demek DEĞİLDİR ───────────
 * Bu işlev `null` dönerse tur hiçbir koşuyu ölü SAYMAZ ve hiçbir şey yeniden
 * başlatmaz. Sebep ölçülebilir bir felaket: motora ulaşılamayan bir turda
 * liste boş dönseydi, havuzdaki HER ticket "ölü" görünür ve hepsi birden
 * yeniden başlatılırdı — kapıda insan onayı bekleyenler dahil. Bir ağ
 * hıçkırığının bedeli, bankanın bütün onay kuyruğunun sessizce silinmesi
 * olamaz.
 */
export interface LiveRuns {
  /** Motorun tanıdığı ticket anahtarları, ya da okunamadıysa `null`. */
  (): Promise<ReadonlySet<string> | null>;
}

/**
 * ÖLÜ BİR KOŞUYU YENİDEN AKIŞA ALAN İŞLEV — turun elindeki tek yeniden
 * başlatma yolu, ve elle düğmeyle AYNI yol (`@maestro/bff` `restartDeadRun`).
 *
 * Buraya bir seam olarak veriliyor, çünkü `apps/deploy`'un bu modülü
 * `ResolvedDeps`in tamamını değil, yalnız "şu ticket'ı yeniden başlat" fiilini
 * tanımalı — `IssueSearcher` ve `CommentReader` ile aynı duruş, ve testin
 * yeniden başlatmayı gerçek bir veritabanı olmadan ölçebilmesinin yolu.
 */
export interface RunRestarter {
  /**
   * Ticket'ın BUGÜNE KADAR kaç kez yeniden başlatıldığı — fren bu sayıyla
   * ölçülür ve ölçüm yeniden başlatmadan ÖNCE yapılır.
   *
   * Neden ayrı bir okuma: sayıyı emekliye ayırmanın kendisi de döndürüyor, ama
   * o cevap ticket ZATEN yeniden başlatıldıktan sonra gelir — yani sınırın
   * dördüncü denemeyi engellemesi için önce bir dördüncü deneme yapılması
   * gerekirdi. Fren, frenlediği şeyden sonra çalışamaz.
   *
   * Kaynak veritabanındaki emekli SATIRLAR, bir bellek sayacı değil: süreç
   * yeniden başlasa da sıfırlanmaz. Bellekte tutulan bir sayaç, her dağıtımda
   * freni sıfırlar ve kalıcı bir hatada döngüyü yeniden açardı.
   */
  readonly priorRestarts: (ticket: TicketKey) => Promise<number>;
  /** Emekliye ayır + yeniden akışa al. `null` = satır kayboldu, yapılacak bir şey yok. */
  readonly restart: (ticket: TicketKey) => Promise<{
    /** Ticket'ın KAÇINCI yeniden başlatılması olduğu, bu dahil. */
    readonly attempt: number;
    /** Alım kabul edildi mi — reddedildiyse sebebiyle. */
    readonly accepted: boolean;
    readonly reason?: string;
  } | null>;
}

/**
 * Koşunun durumunu operatörün okuyabileceği bir cümleye çevirir.
 *
 * Kod adları (`gate`, `running`, `handover`) operatörün kelimeleri değil, ve
 * atlama satırının tamamı zaten bu yanılgıyı düzeltmek için var — kod adı
 * yazmak, "koşusu zaten var" kadar sessiz olurdu.
 */
function runWhere(run: KnownRun): string {
  const status = (run.status ?? "").trim();
  const step = (run.step ?? "").trim();
  const said =
    status === "gate"
      ? "kapıda, insan onayı bekliyor"
      : status === "running"
        ? "çalışıyor"
        : status === "handover"
          ? "insana devredildi"
          : status === "done"
            ? "tamamlandı"
            : status === "cancelled"
              ? "durduruldu"
              : status === "failed"
                ? "hata aldı"
                : status === ""
                  ? ""
                  : status;
  const parts = [said, step === "" ? "" : `adım ${step}`].filter((part) => part !== "");
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
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
  /**
   * Ticket keys the platform already knows about — never started twice.
   *
   * DÜZ ANAHTAR ya da ANAHTAR+DURUM verilebilir, ve ikisi de geçerli:
   *
   *  - `TicketKey[]` — eski şekil. Atlama satırı "koşusu var" der, nokta.
   *  - `{ ticket, step, status }[]` — koşunun NEREDE olduğunu da taşır, ve
   *    atlama satırı bunu yazar: "OTYT-1 atlandı: koşusu var (kapıda bekliyor,
   *    adım 5)".
   *
   * İkinci şeklin sebebi ölçülmüş bir yanılgı: operatör "koşusu zaten var"
   * satırını okuyup "sistem beni duymuyor" diye anlıyor. Koşunun YAŞADIĞINI ve
   * NEREDE olduğunu söylemek, aynı olguyu doğru okutuyor — "tamam, koşu
   * kapıda, benim onayımı bekliyor".
   *
   * Ek bir sorgu MALİYETİ YOK: `WorkflowRun` satırı `step` ve `status`u zaten
   * taşıyor, yalnız `select` genişliyor (bkz. `bin/bff.ts`).
   */
  readonly known: () => Promise<readonly (TicketKey | KnownRun)[]>;
  /**
   * Motorda YAŞAYAN koşular — ölü koşuyu otomatik yeniden başlatmanın ölçüsü.
   *
   * Verilmezse bu kurulumda otomatik yeniden başlatma YOKTUR ve tur bugüne
   * kadar nasıl davranıyorsa öyle davranır: koşusu olan ticket atlanır, nokta.
   * Bu, `tickets`/`statuses` seam'leriyle aynı duruş — ölçemediğimiz bir şeyi
   * varsaymaktansa yapmamak doğru. `restart` olmadan da anlamsız: ikisi
   * birlikte verilir ya da hiç verilmez.
   */
  readonly liveRuns?: LiveRuns;
  /** Ölü koşuyu yeniden akışa alan işlev; bkz. {@link RunRestarter}. */
  readonly restart?: RunRestarter;
  /**
   * BİR TICKET KAÇ KEZ OTOMATİK YENİDEN BAŞLATILABİLİR — sonsuz döngünün freni.
   *
   * ── Neden bir frene ihtiyaç var ───────────────────────────────────────────
   * Operatörün şartı net: havuzdaki bir ticket'ın koşusu düştüyse robot onu
   * KENDİLİĞİNDEN yeniden başlatmalı. Ama koşu KALICI bir sebeple ölüyorsa
   * (bozuk bir repo, cevap vermeyen bir LLM sağlayıcısı, kaldırılmış bir
   * ajan sürümü) frensiz bir tur onu her turda yeniden başlatır: beş dakikada
   * bir yeni koşu, her birinde bir denetim kaydı, bir Jira yorumu, ve LLM
   * çağrıları. Tarama ADMIN bir servis hesabıyla çalışıyor; kontrolsüz bir
   * yeniden başlatma döngüsü bankaya para ve gürültü olarak yansır.
   *
   * ── Neden 3 ───────────────────────────────────────────────────────────────
   * 1 fazla katı olurdu: bir koşu geçici bir sebeple de ölür (worker'ın
   * yeniden başlatıldığı bir dağıtım, Temporal'ın saklama süresinin execution'ı
   * düşürmesi), ve o ticket'ı ilk düşüşte insana devretmek robotun havuzu
   * boşaltma sözünü tutmaması demek olurdu.
   *
   * 2 makul ama dar: iki denemenin ikisi de aynı dağıtım penceresine
   * düşebilir — beş dakika arayla iki tur, bir bakım penceresini
   * geçemeyecek kadar yakın.
   *
   * 3, iki bağımsız geçici hatanın ÜSTÜNDEN geçmeye yeter (varsayılan beş
   * dakikalık turda ~15 dakikalık bir pencere) ve kalıcı bir hatada erken
   * durur. Dördüncüsüne izin verilseydi kazanılan tek şey, kalıcı bir hatada
   * bir tur daha gürültü olurdu.
   *
   * Sayaç ticket'ın EMEKLİ satırlarından okunuyor (`RunCatalog.retire` sayıyı
   * kendisi döndürüyor), yani süreç yeniden başlasa da sıfırlanmaz — sayacı
   * bellekte tutmak, her dağıtımda freni sıfırlamak olurdu.
   */
  readonly maxAutoRestarts?: number;
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
  /**
   * HAVUZDA KALAN İŞ — turun tur başı sınırına takılıp bırakmak zorunda
   * kaldığı ticket sayısı, `null` ise "havuz boşaldı".
   *
   * ── Neden bu alan var ────────────────────────────────────────────────────
   * Operatörün modeli: "robotun statü havuzu olur ve orada kendine atanmış her
   * şeyi BİTENE KADAR devam eder". Tur başına sabit bir sınır (20) o modelin
   * tersini üretiyordu ve HİÇBİR YERDE GÖRÜNMÜYORDU: log "20 ticket alındı"
   * diyordu, geride 30 iş kaldığını söylemiyordu. Operatör bunu "atlıyor" diye
   * okur, ve haklıdır — sistemin ona söylemediği bir şey oluyordur.
   *
   * `0` ile `null` AYNI ŞEY DEĞİL: `0` "sınıra takıldık ama kalan da yoktu"
   * (tam 20 iş vardı), `null` "sınıra hiç takılmadık". İkisi de havuzun boş
   * olduğunu söyler, ama birincisi bir sonraki turda tekrar bakmak için bir
   * sebep — sayı bir TAHMİN, çünkü sınıra takılan tur kalanları saymayı
   * bitirememiştir.
   */
  readonly poolRemaining: number | null;
  /**
   * Son turda OTOMATİK yeniden başlatılan ölü koşu sayısı.
   *
   * Panelde ayrı bir satır, çünkü "alındı" ile karıştırılmamalı: 0 ticket
   * alan ama 2 ölü koşuyu yeniden başlatan bir tur ÇALIŞAN bir turdur, ve
   * özetin tek sayısı bunu söyleyemez.
   */
  readonly lastRestarted: number;
  /**
   * Frene takılıp İNSANA DEVREDİLEN ticket'lar — son turda kaç tane.
   *
   * Bu sayı 0'dan büyükse operatörün BAKMASI gereken bir şey var: bir ticket
   * üst üste ölüyor ve robot artık denemiyor. Panelin bunu göstermemesi,
   * frenin sessizce çalışması demek olurdu — ki bu, döngünün kendisi kadar
   * kötü bir sessizlik.
   */
  readonly lastHandedOver: number;
  /** Son turda havuzda kalan (koşusu bitmiş) ticket sayısı ve ilk on anahtar. */
  readonly lastLeftInPool: number;
  readonly leftInPoolKeys: readonly string[];
}

const status: { current: DiscoveryStatus } = {
  current: {
    enabled: false,
    intervalMs: 0,
    lastRunAt: null,
    lastStarted: 0,
    rulesSearched: 0,
    lastError: null,
    poolRemaining: null,
    lastRestarted: 0,
    lastHandedOver: 0,
    lastLeftInPool: 0,
    leftInPoolKeys: [],
  },
};

/** The last round's outcome, for the Studio screen. */
export function discoveryStatus(): DiscoveryStatus {
  return status.current;
}

/** How many tickets one round may start, unless the caller says otherwise. */
const DEFAULT_MAX_PER_ROUND = 20;

/** Bir ticket'ın otomatik yeniden başlatılma sınırı — gerekçesi `maxAutoRestarts`ta. */
const DEFAULT_MAX_AUTO_RESTARTS = 3;

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
  /** A status / issue-type term: a bare numeric id, else the quoted name. See below. */
  const term = (value: string): string => {
    const trimmed = value.trim();
    return /^[0-9]+$/u.test(trimmed) ? trimmed : quoted(trimmed);
  };
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
  const gate = statuses.length === 0 ? "" : ` AND status in (${statuses.map(term).join(", ")})`;

  const base = `project = ${quoted(rule.projectKey)} AND assignee in (${account})${gate}`;
  /**
   * ── CANLI BULGU: TAKIM YÖNETİMLİ PROJEDE AD İLE DARALTMA BOŞ DÖNER ──────────
   * Ölçüldü (`style: "next-gen"`, OPS): aynı ticket kümesi üzerinde
   *   issuetype = "Görev"        → 0      issuetype = 10008 → 14
   *   status in ("Yapılacaklar") → 0      status = 10004    → 12
   * Ad, o projenin kendi şemasında global bir ada çözülmüyor; hata da vermiyor,
   * BOŞ dönüyor. Yani `issuetype` ve `status` kuralları sessizce hiç eşleşmiyor
   * ve panel "kural arandı, 0 ticket" diyordu — bu fonksiyonun var olma sebebi
   * olan sessiz-sonsuz hatanın aynısı.
   *
   * SAYISAL DEĞER TIRNAKSIZ GEÇER. Bir ad ile bir id'yi ayıran şey basit: id
   * yalnız rakamdır. Şirket yönetimli projeler ADLA çalışmaya devam eder (orada
   * ad global ve tırnaklı biçim doğru olan); takım yönetimli bir projede
   * operatör değeri id olarak yazdığında o id buradan tırnaksız geçer ve sorgu
   * tutar. İki dünyayı tek satır karşılar, ve hiçbir kurulumun davranışı
   * bozulmaz — çünkü rakamdan ibaret bir STATÜ ADI yoktur.
   *
   * Daraltma yine de bir OPTİMİZASYONDUR, doğruluk şartı değil: taramanın
   * bulduğu her ticket `runIntake` → `decideFlow` → `matches()` elemesinden
   * geçiyor ve ORASI ticket'ın ADINI karşılaştırıyor. JQL geniş dönse bile
   * yanlış ticket işlenmez; dar dönmesi yalnız Jira'ya daha az yük demek.
   */
  if (rule.matchKind === "status") return `${base} AND status = ${term(rule.matchValue)}`;
  if (rule.matchKind === "issuetype") return `${base} AND issuetype = ${term(rule.matchValue)}`;
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
 * TEŞHİS SORGUSU — kural 0 döndüğünde "peki projede NE var?".
 *
 * Kuralın JQL'i log'a yazılıyor (1.0.17), ama operatör o sorguyu Jira'nın
 * GERÇEKTE ne taşıdığıyla karşılaştıramıyor: "kuralım `issuetype = Görev`
 * diyor" ile "Jira'da hepsi `Task` yazıyor" arasındaki farkı görmek için
 * ikinci yarıya da bakması gerek. Dört olası sebep var — tip adı farklı,
 * statü tutmuyor, ticket bota atanmamış, etiket yok — ve dördü de bu tek
 * listede tek bakışta ayırt edilir.
 *
 * Sorgu DARALTILMIŞ kalır: `project = "X" AND statusCategory != Done`. Admin
 * bir servis hesabıyla koşan bir kurulumda tüm bankayı taramak kabul
 * edilemez, o yüzden sınır kuralın kendi projesi — ki bu proje `boundProjects`
 * kapısından çoktan geçmiştir.
 *
 * Alanlar kuralın sorgusuyla BİREBİR AYNI (`status,issuetype,assignee,labels`):
 * `summary`/`description` istenmez, yani bu yol da hiç ticket METNİ taşımaz.
 * Log'a düşen her şey — proje anahtarı, tip/statü adı, atanan, etiket —
 * panelin zaten gösterdiği yapılandırmanın aynısıdır.
 */
const DIAGNOSTIC_SAMPLE = 5;

export function diagnosticJqlFor(projectKey: string): string {
  return `project = "${projectKey.replace(/"/gu, '\\"')}" AND statusCategory != Done ORDER BY created DESC`;
}

/** Bir teşhis satırı: `OTYT-12  tip="Task"  statü="To Do"  atanan=(yok)  etiket=[]`. */
function diagnosticLineOf(issue: unknown): string {
  const key = issueKeyOf(issue) ?? "(anahtarsız)";
  const fields = classifyingFieldsOf(issue);
  const labels = fields.labels ?? [];
  return (
    `         ${key.padEnd(10)} tip=${JSON.stringify(fields.issueType ?? "")} ` +
    `statü=${JSON.stringify(fields.status ?? "")} ` +
    `atanan=${fields.assignee ?? "(yok)"} etiket=[${labels.join(", ")}]`
  );
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

  /**
   * Anahtar → koşunun nerede olduğu. İki şekli de kabul eder (bkz. `known`):
   * düz anahtar boş bir `KnownRun`a düşer ve satır eskisi gibi yalnız
   * "koşusu var" der.
   */
  const known = new Map<string, KnownRun>(
    (await options.known().catch(() => [])).map((entry) =>
      typeof entry === "string"
        ? ([entry, { ticket: entry }] as const)
        : ([entry.ticket, entry] as const),
    ),
  );
  /**
   * MOTORDA YAŞAYAN KOŞULAR — tur başına TEK bir okuma.
   *
   * Döngünün İÇİNDE değil, öncesinde: aynı sayfayı ticket başına yeniden
   * okumak, kaçınılan maliyetin ta kendisi olurdu. `null` = motor okunamadı,
   * ve o durumda hiçbir koşu ölü SAYILMAZ (bkz. `LiveRuns`).
   *
   * Seam verilmemişse okuma da yapılmaz: otomatik yeniden başlatma bu
   * kurulumda kapalıdır ve tur eskisi gibi davranır.
   */
  const canRestart = options.liveRuns !== undefined && options.restart !== undefined;
  const alive: ReadonlySet<string> | null = canRestart
    ? await options.liveRuns!().catch((error: unknown) => {
        log(
          `[keşif] motorun koşu listesi okunamadı: ${String(error)} — ` +
            "bu turda hiçbir ölü koşu yeniden başlatılmayacak (okunamayan bir motoru " +
            "'her koşu ölmüş' saymak, kapıda bekleyen canlı koşuları da silerdi).",
        );
        return null;
      })
    : null;
  /** Bu turda otomatik yeniden başlatılan ticket'lar. */
  let restarted = 0;
  /** Frene takılıp insana devredilen ticket'lar — operatörün bakması gereken sayı. */
  let handedOver = 0;
  const restartLimit = options.maxAutoRestarts ?? DEFAULT_MAX_AUTO_RESTARTS;

  const started: TicketKey[] = [];
  // Deduped across rules: several rules routinely match one ticket (an
  // `assigned` wildcard beside a per-issuetype rule), and starting it twice
  // would be two runs for one piece of work.
  const seenThisRound = new Set<string>();
  /** Keys Jira returned this round, before the already-known filter. */
  let scanned = 0;
  /** Rules that could not be turned into a bounded query — see `jqlFor`. */
  let skippedRules = 0;
  /** Tickets a rule matched that already carry a run — the sweep's usual case. */
  let alreadyKnown = 0;
  // Koşusu bitmiş ama hâlâ havuzda duran ticket'lar (bkz. `leftInPool`).
  const stuckInPool: string[] = [];
  /**
   * Teşhis sorgusu atılmış projeler — TUR BAŞINA PROJE BAŞINA EN FAZLA BİR KEZ.
   *
   * Aynı projede beş kural varsa beşi de 0 dönebilir; beş kez sormak Jira'ya
   * gereksiz beş çağrı ve log'a birbirinin aynısı beş blok demek. İlk 0 dönen
   * kural cevabı zaten getirir, kalanların hepsi aynı listeye bakar.
   */
  const diagnosed = new Set<string>();
  /**
   * HAVUZDA BIRAKILAN İŞ — tur başı sınırına takıldığı için alınamayan,
   * alınabilir olduğu GÖRÜLEN ticket sayısı.
   *
   * Yalnız GERÇEKTEN alınabilir olanlar sayılır: koşusu olan, bu turda başka
   * bir kuralla görülmüş, ya da anahtarsız bir satır kalan sayılmaz — onlar
   * sınır kalksa da alınmayacaktı, ve sayıya katmak operatöre olmayan bir
   * birikimi gösterirdi.
   *
   * TAHMİNDİR ve öyle olduğu söylenir: sınıra takılan tur kalan KURALLARI hiç
   * aramaz, dolayısıyla sayı yalnız o ana kadar GÖRÜLENİ kapsar. Gerçek
   * birikim bundan büyük olabilir — bu yüzden log satırı "en az" der.
   */
  let leftInPool = 0;
  /** Sınıra gerçekten takıldık mı — `leftInPool === 0` ile karıştırılmamalı. */
  let hitCap = false;
  /**
   * TUR BAŞI SINIRININ SAYDIĞI ŞEY — ve neden `started` DEĞİL.
   *
   * Sınır `started.length` üzerinden ölçülüyordu, yani yalnız KABUL EDİLEN
   * ticket'lar sayılıyordu. Ölçülen sonuç: bağlı olmayan bir projede (ya da
   * kill-switch açıkken, ya da uygulaması olmayan bir akışta) her ticket
   * reddediliyor, `started` hiç artmıyor ve sınır HİÇ DEVREYE GİRMİYORDU. Yüz
   * ticket'lık bir havuz, her turda yüz kez `runIntake` çağrısı demekti — ve
   * `runIntake` bir denetim satırı yazan, sayaç artıran, karar dökümü üreten
   * bir iş. Sınırın var olma sebebi tam olarak buydu ve sınır o durumda YOKTU.
   *
   * `examined` İNCELENEN her ticket'ı sayar: kabul edilen de, reddedilen de.
   * Atlananlar (koşusu olan, bu turda görülmüş) sayılmaz — onlar için hiçbir
   * iş yapılmadı, yalnız bir karşılaştırma.
   *
   * Bu, "20 ticket alındı" cümlesini değiştirmiyor: `started` hâlâ alınanı
   * sayıyor ve log onu yazıyor. Değişen, sınırın neyi FRENLEDİĞİ.
   */
  let examined = 0;

  for (const rule of rules) {
    if (examined >= cap) {
      // Kalan kuralları HİÇ ARAMADIK. Bunu bir kalan olarak saymıyoruz (kaç
      // ticket olduğunu bilmiyoruz), ama sınıra takıldığımızı işaretliyoruz:
      // çağıran turu tekrarlayacak ve bu kurallar o turda aranacak.
      hitCap = true;
      break;
    }

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
        /**
         * SINIRDAN BİR FAZLA — havuzda kalan olup olmadığını ÖLÇMENİN tek yolu.
         *
         * Eskiden `cap` isteniyordu, ve o rakam iki soruyu birden cevaplıyor
         * sanılıyordu: "kaçını alabilirim" ve "kaç tane var". İkincisini
         * cevaplamıyordu. `maxResults: 20` gönderen bir tur, havuzda 20 iş de
         * olsa 200 iş de olsa AYNI 20 satırı alır — yani "havuzda kalan var
         * mı" sorusunun cevabını Jira'ya hiç sormamış olur. Operatörün
         * "durmaz atlamaz" beklentisinin ölçülemez olmasının teknik sebebi
         * tam olarak buydu.
         *
         * Bir fazlası, o soruyu sormanın en ucuz hâli: sayfa `cap`ten uzunsa
         * havuzda daha var, kısaysa yok. Fazladan gelen satır ALINMAZ —
         * aşağıdaki `started.length >= cap` kontrolü onu keser — yalnız
         * SAYILIR. Yani tur başı sınırı gevşemiyor, yalnız görülebiliyor.
         *
         * Sayfalama (`startAt`) yerine bu: sayfalama gerçek birikimin tamamını
         * verirdi, ama admin yetkili bir hesapla her turda havuzun tamamını
         * gezmek demekti. Bir fazlası "daha var mı" sorusuna yeter, ve "en az
         * N" cümlesi zaten bunun dürüst ifadesi.
         */
        maxResults: cap + 1,
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
      /**
       * THE QUERY, AND WHAT IT FOUND — one line per rule, per round.
       *
       * The round summary ("6 kural arandı, 0 ticket alındı") says a rule found
       * nothing; it never says WHAT the rule looked for, and those are
       * different facts with different fixes. An operator whose issue-type rule
       * returns nothing has four candidates — the ticket is not assigned to the
       * bot, the type name does not match Jira's spelling, the status gate
       * excludes it, the project key is wrong — and the query answers all four
       * at a glance, because Jira answered it without complaint.
       *
       * Logged at INFO rather than DEBUG: this is the sweep's only observable
       * output on an install with no webhook, where the sweep is the only door
       * a ticket has. A JQL string holds a project key, an account id and a
       * status name — configuration the panel already shows, never ticket
       * content, which is why `fields` deliberately excludes summary and
       * description.
       */
      log(`[keşif] ${rule.projectKey}/${rule.matchKind}: ${issues.length} sonuç · JQL: ${jql}`);
      /**
       * SIFIR SONUÇ → BİR KEZ, PROJEDE NE OLDUĞUNU SOR.
       *
       * Yalnız burada: dolu dönen bir kuralın teşhise ihtiyacı yok, ve her
       * turda atılan bir sorgu olmamalı. Hatası YUTULUR — teşhis bir kolaylık,
       * turun kendisi değil; izin yetmediği ya da JQL'i Jira'nın beğenmediği
       * bir kurulumda tarama aynen devam etmeli.
       */
      if (issues.length === 0 && !diagnosed.has(rule.projectKey)) {
        diagnosed.add(rule.projectKey);
        await runDiagnostic(options.search, rule.projectKey, log);
      }
    } catch (error) {
      // One rule's failure must not stop the others: a project whose
      // permissions changed would otherwise freeze discovery for every project.
      log(`[keşif] ${rule.projectKey}/${rule.matchValue}: ${String(error)}`);
      continue;
    }

    for (const issue of issues) {
      if (examined >= cap) {
        hitCap = true;
        // Bu sayfada kalan HER satır bir kalan ADAYI. Alınabilir olup
        // olmadığını burada ölçemiyoruz (koşusu var mı, anahtarı var mı) —
        // ölçüyoruz da: aşağıdaki iki eleme aynen uygulanıyor, çünkü
        // operatöre gösterilecek sayının anlamlı olması gerekiyor.
        const key = issueKeyOf(issue);
        if (key !== null && !known.has(key) && !seenThisRound.has(key)) leftInPool += 1;
        continue;
      }
      // An issue with no key is nothing this loop can act on. Jira does not
      // send such a row; skipping rather than throwing keeps one odd payload
      // from ending a round that has other tickets in it.
      const key = issueKeyOf(issue);
      if (key === null) continue;
      const knownRun = known.get(key);

      /**
       * ── HAVUZDAKİ TICKET'IN KOŞUSU ÖLMÜŞSE OTOMATİK YENİDEN BAŞLAT ────────
       *
       * Operatörün modeli baştan beri şu: "robotun bir statü havuzu olur ve
       * orada kendine atanmış HER ŞEYİ bitene kadar devam eder". Bu satırın
       * öncesinde tur, koşusu olan her ticket'ı — ölüsünü de — atlıyordu, ve
       * gerekçesi yazılıydı: "düşmüş bir koşu bir insanın kararıdır,
       * zamanlayıcının yeniden deneyeceği bir şey değil".
       *
       * O gerekçe operatörün modeliyle ÇELİŞİYOR ve sahada ölçülen sonuç şuydu:
       * ticket havuzda duruyor, panelde adımları görünüyor, kapıda
       * "onayla/reddet" yazıyor, basıldığında "bu ticket için çalışan bir akış
       * yok" cevabı geliyor — ve robot hiçbir şey yapmıyor. Havuzda iş varsa
       * robotun işidir; koşunun daha önce düşmüş olması ticket'ı havuzdan
       * çıkarmaz.
       *
       * ── ÜÇ FREN, sırayla ─────────────────────────────────────────────────
       *  1. CANLI KOŞUYA DOKUNULMAZ. `alive` motorun kendi listesi; ticket
       *     oradaysa koşu yaşıyor demektir ve yeniden başlatmak, kapıda
       *     bekleyen bir insan onayını sessizce çöpe atmak olurdu.
       *  2. MOTOR OKUNAMADIYSA HİÇBİR ŞEY. `alive === null` bir ağ hıçkırığı
       *     olabilir, ve o turda "her koşu ölü" saymak bütün onay kuyruğunu
       *     silerdi (bkz. `LiveRuns`).
       *  3. SAYAÇ — aynı ticket `maxAutoRestarts` kez yeniden başlatıldıysa
       *     DUR ve insana devret. Sayaç emekli SATIRLARDAN okunuyor, yani
       *     süreç yeniden başlasa da sıfırlanmaz.
       *
       * Ayrıca `seenThisRound`: yeniden başlatılan ticket bu turda ikinci bir
       * kuralla yeniden görülüp ikinci kez başlatılmasın.
       */
      if (
        knownRun !== undefined &&
        !seenThisRound.has(key) &&
        canRestart &&
        // Ölü: motorda yaşayan koşular arasında yok — YA DA kaydı "hatalı"
        // (yürütme düşmüş). İkincisi motor okunamasa da bilinir: hatalı bir
        // koşu havuzdaki ticket'ı "koşusu zaten var" diye kilitleyemez;
        // operatörün kuralı "hangi adımda düştüyse düşsün, takılmak yok".
        // Fren aynı (pencereli sayaç), Jira'ya yazan da aynı yol.
        ((alive !== null && !alive.has(key)) ||
          isFailedRun(knownRun) ||
          finishedButPooled(knownRun))
      ) {
        seenThisRound.add(key);
        // Fren, frenlediği şeyden ÖNCE: sayaç veritabanından okunur ve sınıra
        // ulaşmışsa hiçbir yeniden başlatma yapılmaz. Sayıyı emekliye
        // ayırmanın dönüşünden okumak, sınırı aşan denemeyi ancak YAPTIKTAN
        // sonra fark etmek olurdu.
        // Sayaç okunamadıysa yeniden başlatma YOK: freni ÖLÇEMEDİĞİMİZ bir
        // turda denemek, freni hiç koymamakla aynı şey olurdu. Fail-closed,
        // ve bu bir DEVİR değil bir atlama — sayı bilinmiyor, tükenmiş değil.
        const prior = await options
          .restart!.priorRestarts(key as TicketKey)
          .catch((error: unknown) => {
            log(`[keşif] ${key} yeniden başlatma sayacı okunamadı: ${String(error)} — atlandı`);
            return null;
          });
        if (prior === null) continue;
        if (prior >= restartLimit) {
          handedOver += 1;
          log(
            `[keşif] ${key} YENİDEN BAŞLATILMADI: ${restartWhy(knownRun, alive)}, ama bu ticket ` +
              `zaten ${restartLimit} kez otomatik yeniden başlatıldı — İNSANA DEVREDİLDİ. ` +
              "Kalıcı bir hata var demektir; koşunun defterine bakın (Ticket'lar ekranı), " +
              "sebebi giderdikten sonra Yeniden başlat düğmesiyle elle başlatın.",
          );
          continue;
        }
        // Alt kademedeki hata turu DÜŞÜRMEZ: bir ticket'ın yeniden
        // başlatılamaması, diğerlerinin de başlatılmaması için sebep değil.
        const outcome = await options.restart!.restart(key as TicketKey).catch((error: unknown) => {
          log(`[keşif] ${key} yeniden başlatılamadı: ${String(error)}`);
          return null;
        });
        if (outcome === null) continue;
        if (outcome.accepted) {
          restarted += 1;
          started.push(key as TicketKey);
        }
        /**
         * HER OTOMATİK YENİDEN BAŞLATMA GÖRÜNÜR — log'a ve denetim zincirine.
         *
         * Denetim kaydını `restartDeadRun` yazıyor (`source: "sweep"`,
         * `attempt: N`); bu satır operatörün ilk baktığı yer olan LOG'un
         * karşılığı. Kaçıncı deneme olduğu ikisinde de yazılı, çünkü
         * "yeniden başlatıldı" ile "üçüncü kez yeniden başlatıldı" bambaşka
         * iki haber: ikincisi operatörün bakması gereken bir şey.
         */
        log(
          `[keşif] ${key}: ${restartWhy(knownRun, alive)} (${outcome.attempt}. yeniden başlatma), ` +
            `emekliye ayrıldı, yeniden akışa alındı` +
            (outcome.accepted ? "" : ` — ama alım reddedildi: ${outcome.reason ?? ""}`),
        );
        continue;
      }

      if (knownRun !== undefined || seenThisRound.has(key)) {
        // Counted, not silent. A round that finds fourteen tickets and starts
        // none reads as a broken sweep; "fourteen already have a run" reads as
        // a working one. The two are indistinguishable in the summary line, and
        // that ambiguity is what sent an operator looking for a bug in the
        // query that had just done its job.
        alreadyKnown += 1;
        /**
         * ── ATLAMA ARTIK TİCKET BAŞINA DA YAZILIYOR ──────────────────────
         *
         * Tur özeti "14'ünün koşusu zaten var" diyordu ve doğruydu, ama
         * operatör bunu "sistem beni duymuyor" diye okuyor — hangi ticket,
         * ve koşu YAŞIYOR MU, satırda yoktu. Koşunun nerede olduğunu söylemek
         * aynı olguyu doğru okutuyor: "tamam, koşu kapıda, benim onayımı
         * bekliyor".
         *
         * Yalnız GERÇEK bir koşu için yazılır; `seenThisRound` çakışması
         * (aynı turda iki kuralın aynı ticket'ı görmesi) operatörün bir şey
         * yapmasını gerektirmeyen bir iç ayrıntı ve satırı gürültüye boğardı.
         */
        if (knownRun !== undefined) {
          log(`[keşif] ${key} atlandı: koşusu var${runWhere(knownRun)}`);
          if (finishedButPooled(knownRun)) {
            // İşi bitmiş, ticket hâlâ havuzda: "havuzda ticket kalamaz"
            // kuralının ihlali. Sayılır ve adlandırılır; tur özeti ile
            // tarama bandı bunu operatöre söyler.
            stuckInPool.push(key);
          }
        }
        continue;
      }
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
      // İncelemeye BAŞLIYORUZ — `runIntake` çağrısından hemen önce, çünkü
      // sınırın frenlediği iş bu çağrının kendisi (denetim satırı, sayaç,
      // karar dökümü, ve kabul edilirse bir koşu).
      examined += 1;

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
      // "0 alındı" ile "0 alındı ama 14'ünün zaten koşusu var" aynı satırda
      // görünüyordu, ve ikisi bambaşka: biri bozuk bir sorgu, diğeri çalışan
      // bir tarama. Bu belirsizlik bir operatörü, işini yeni yapmış bir
      // sorguda hata aramaya gönderdi.
      `${alreadyKnown === 0 ? "" : `, ${alreadyKnown}'inin koşusu zaten var`}` +
      // Counted in the summary too, not only in the per-rule line above: an
      // operator scanning one line per round must see that some rules were
      // never searched at all.
      `${skippedRules === 0 ? "" : `, ${skippedRules} kural bot hesabı olmadığı için atlandı`}` +
      /**
       * HAVUZDA KALAN — operatörün "durmaz atlamaz" beklentisinin ölçüldüğü
       * satır.
       *
       * Bu satır olmadan sınıra takılan bir tur, sınıra takılmayan bir turdan
       * AYIRT EDİLEMİYORDU: log "20 ticket alındı" diyor, geride 30 iş
       * kaldığını söylemiyordu. Operatör bunu "sistem atlıyor" diye okur.
       *
       * "en az" YAZILIYOR ve bu bir çekingenlik değil bir doğruluk: sınıra
       * takılan tur kalan KURALLARI hiç aramamıştır, dolayısıyla gerçek
       * birikim bu sayıdan büyük olabilir. Kesin bir sayı vermek, kesin
       * olmayan bir şeyi kesinmiş gibi söylemek olurdu.
       */
      /**
       * ÖLÜ KOŞULAR — turun ikinci işi, ve özette AYRI bir sayı.
       *
       * "0 ticket alındı" diyen bir tur, iki ölü koşuyu yeniden akışa almış
       * olabilir: yeni ticket yoktu ama havuzdaki iş ilerledi. Tek bir sayı bu
       * ikisini ayırt edemez, ve operatörün "robot duruyor mu" sorusunun
       * cevabı tam olarak bu farkta.
       */
      `${restarted === 0 ? "" : `, ${restarted} ölü koşu otomatik yeniden başlatıldı`}` +
      // Devir sayısı özetin en önemli rakamı olabilir: 0'dan büyükse bir
      // ticket üst üste ölüyor ve robot artık denemiyor. Operatörün BAKMASI
      // gereken tek satır bu olabilir, ve gürültünün içinde kaybolmamalı.
      `${handedOver === 0 ? "" : `, ${handedOver} ticket üst üste düştüğü için İNSANA DEVREDİLDİ`}` +
      `${hitCap ? `, tur sınırına (${cap}) takıldı — havuzda en az ${leftInPool} iş kaldı, hemen yeni tur yapılacak` : ""}`,
  );
  record({
    lastError: null,
    rulesSearched: rules.length - skippedRules,
    lastStarted: started.length,
    lastRestarted: restarted,
    lastHandedOver: handedOver,
    lastLeftInPool: stuckInPool.length,
    leftInPoolKeys: stuckInPool.slice(0, 10),
    // `null` = "sınıra hiç takılmadık, havuz boşaldı". Sınıra takıldıysak
    // sayı verilir — `0` bile, çünkü `0` da "tekrar bak" demek: takılan tur
    // kalan kuralları aramamıştır.
    ...(hitCap ? { poolRemaining: leftInPool } : {}),
  });
  return started;
}

/**
 * Kural boş döndü — projede açık ne var, alanlarıyla.
 *
 * Asla throw etmez. Bu satırların tek işi operatörün kuralını Jira'nın
 * gerçeğiyle yan yana koyabilmesi; teşhisin başarısız olması taramanın
 * başarısız olması değildir.
 */
async function runDiagnostic(
  search: IssueSearcher,
  projectKey: string,
  log: (message: string) => void,
): Promise<void> {
  try {
    const probe = diagnosticJqlFor(projectKey);
    const page = await search.searchIssues({
      jql: probe,
      maxResults: DIAGNOSTIC_SAMPLE,
      // Kuralın istediği dört alanın AYNISI — ticket metni yok.
      fields: ["status", "issuetype", "assignee", "labels"],
    });
    const issues = page.issues;
    if (issues.length === 0) {
      log(
        `[keşif] ${projectKey} teşhis — projede hiç açık ticket yok · JQL: ${probe}` +
          " (proje anahtarı yanlış olabilir ya da tüm ticket'lar kapalı)",
      );
      return;
    }
    log(`[keşif] ${projectKey} teşhis — projede açık ticket var, ilk ${issues.length}:`);
    for (const issue of issues) log(diagnosticLineOf(issue));
    log(
      `[keşif] ${projectKey} teşhis — kuralınızdaki tip/statü/atanan/etiket değerleri ` +
        "yukarıdakilerle BİREBİR aynı mı? Değilse eşleşme olmaz.",
    );
  } catch (error) {
    log(`[keşif] ${projectKey} teşhis sorgusu yapılamadı: ${String(error)}`);
  }
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
  statusId?: string;
  issueType?: string;
  issueTypeId?: string;
  assignee?: string;
  labels?: readonly string[];
} {
  const status = nameOf(issue, "status");
  const issueType = nameOf(issue, "issuetype");
  /**
   * KİMLİKLER de okunuyor — takım yönetimli projede kuralın gerçekten
   * karşılaştırdığı değerler.
   *
   * Arama zaten `fields: ["status", "issuetype", ...]` istiyor ve Jira her
   * ikisini de `{id, name}` olarak döndürüyor: kimlik ek bir istek DEĞİL,
   * cevapta hâlihazırda duran ama okunmayan alan. O projede kural `10008`
   * tutar, `"Görev"` değil (`jqlFor` `term()`), ve `flow-decision.ts` sayısal
   * bir `matchValue`'yu id ile karşılaştırır — okunmadıklarında tur, kuralın
   * KENDİ sorgusuyla bulduğu ticket'ı aynı kuralla eşleştiremezdi.
   */
  const statusId = idOf(issue, "status");
  const issueTypeId = idOf(issue, "issuetype");
  const assignee = assigneeOf(issue);
  const labels = labelsOf(issue);
  return {
    ...(status === null ? {} : { status }),
    ...(statusId === null ? {} : { statusId }),
    ...(issueType === null ? {} : { issueType }),
    ...(issueTypeId === null ? {} : { issueTypeId }),
    ...(assignee === null ? {} : { assignee }),
    ...(labels === null ? {} : { labels }),
  };
}

/** Stamp the round's outcome onto the status the panel reads. */
function record(
  round: Pick<DiscoveryStatus, "lastError" | "rulesSearched" | "lastStarted"> &
    Partial<
      Pick<DiscoveryStatus, "poolRemaining" | "lastRestarted" | "lastHandedOver" | "lastLeftInPool" | "leftInPoolKeys">
    >,
): void {
  status.current = {
    ...status.current,
    ...round,
    // `poolRemaining` ile aynı gerekçe: bir önceki turun "2 koşu yeniden
    // başlatıldı" cevabı, hiçbir şey yeniden başlatmayan bir turdan sonra
    // ekranda durmamalı. Her tur kendi sayısını yazar; yokluk sıfırdır.
    lastRestarted: round.lastRestarted ?? 0,
    lastHandedOver: round.lastHandedOver ?? 0,
    // Aynı kural: havuzda kalan, her turun kendi cevabıdır.
    lastLeftInPool: round.lastLeftInPool ?? 0,
    leftInPoolKeys: round.leftInPoolKeys ?? [],
    // HER TUR BU ALANI YENİDEN YAZAR — `...round` alanı taşımasa bile.
    // Yoksa bir önceki turun "30 iş kaldı" cevabı, kalanı olmayan bir turdan
    // sonra ekranda durmaya devam eder ve operatör var olmayan bir birikimi
    // kovalardı. Yokluk = "kalan yok", çünkü kalanı olan her tur onu SÖYLER.
    poolRemaining: round.poolRemaining ?? null,
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
  const log = options.log ?? ((message: string): void => console.log(message));
  /**
   * ── HAVUZ BOŞALANA KADAR — ve GÜVENLE ────────────────────────────────────
   *
   * Operatörün modeli: "robotun statü havuzu olur ve orada kendine atanmış her
   * şeyi BİTENE KADAR devam eder: reddeder ya da işi yapar, bir sonraki adıma
   * ilerletir". Tur başına sabit 20 sınırı bunun tersini üretiyordu: 50 iş
   * varsa 20'si alınıyor, kalan 30'u BİR SONRAKİ turu (varsayılan 300 sn)
   * bekliyordu. 50 iş ≈ 15 dakika, ve operatör bunu "atlıyor" diye okuyordu.
   *
   * Çözüm sınırı KALDIRMAK DEĞİL — tur başı sınırı Jira'yı ve bu süreci
   * koruyan şey, ve `runIntake` her ticket için model çağrısı zincirini
   * başlatıyor. Çözüm, sınıra takılan turu HEMEN TEKRARLAMAK: havuz boşalana
   * kadar arka arkaya turlar, aradaki 300 sn beklemeden.
   *
   * ── VE NEDEN SINIRSIZ DEĞİL ──────────────────────────────────────────────
   * Bu platformun Jira servis hesabı rutin olarak ADMIN. Kontrolsüz bir döngü,
   * yanlış yazılmış tek bir kuralla (ya da bir anda binlerce ticket'ı bota
   * atayan bir toplu işlemle) bankadaki her projeyi analize sokabilir. İki
   * fren birden var ve ikisi de ölçülebilir:
   *
   *   · `MAX_DRAIN_ROUNDS` — bir boşaltmada en fazla kaç tur.
   *   · `MAX_DRAIN_MS`     — bir boşaltmanın en fazla ne kadar sürebileceği.
   *
   * Hangisi önce dolarsa boşaltma DURUR, kalan iş bir sonraki normal tura
   * bırakılır ve bu AÇIKÇA loglanır. "Durdu ve söylemedi" ile "durdu ve
   * söyledi" arasındaki fark, operatörün sabah ne göreceğidir.
   *
   * `stopped` her turdan sonra yeniden sorulur: kapatma sinyali bir
   * boşaltmanın ortasında da geçerlidir.
   */
  const MAX_DRAIN_ROUNDS = 10;
  const MAX_DRAIN_MS = 5 * 60 * 1_000;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const until = Date.now() + MAX_DRAIN_MS;
    for (let round = 1; round <= MAX_DRAIN_ROUNDS; round += 1) {
      const taken = await discoverOnce(options).catch((error: unknown) => {
        log(`[keşif] tur başarısız: ${String(error)}`);
        return [];
      });
      if (stopped) return;
      /**
       * ── ÜÇÜNCÜ FREN: İLERLEME OLMAYAN TUR TEKRARLANMAZ ────────────────────
       *
       * Tur sınırı İNCELENEN ticket'ı sayıyor, alınanı değil (bkz. `examined`),
       * ve bu doğru — ama tek başına yeni bir tehlike açardı: bağlanmamış bir
       * projede (ya da kill-switch açıkken) HER ticket reddedilir, sınır her
       * turda dolar, ve boşaltma döngüsü hiçbir şey ilerletmeden on tur döner.
       * Her turda aynı ticket'lara aynı cevabı verirdi.
       *
       * Bir tur HİÇ ticket ALMADIYSA boşaltmanın devam etmesinin bir anlamı
       * yok: havuz ya gerçekten alınamaz işlerle dolu (operatörün çözmesi
       * gereken bir yapılandırma), ya da alınacak bir şey kalmamış. İkisinde
       * de doğru cevap normal aralığı beklemek.
       *
       * `poolRemaining` yine de bildirilmiş durumda kalır, yani panel ve log
       * birikimi söylemeye devam eder — susmuyoruz, yalnız döngüyü sürmüyoruz.
       */
      if (taken.length === 0) {
        if (status.current.poolRemaining !== null) {
          log(
            "[keşif] havuzda iş görünüyor ama bu turda hiçbiri alınamadı — " +
              "boşaltma sürdürülmüyor, bir sonraki normal turda tekrar bakılacak. " +
              "Alınmama sebepleri yukarıdaki satırlarda ('alınmadı: ...').",
          );
        }
        return;
      }
      // `poolRemaining === null` = "sınıra takılmadık, havuz boşaldı". Tek
      // çıkış koşulu bu; sayının kendisi bir tahmin olduğu için ona göre karar
      // verilmiyor, yalnız VARLIĞINA göre.
      const remaining = status.current.poolRemaining;
      if (remaining === null) {
        if (round > 1) log(`[keşif] havuz boşaldı — ${round} tur sürdü`);
        return;
      }
      if (round === MAX_DRAIN_ROUNDS) {
        log(
          `[keşif] havuz boşaltma ${MAX_DRAIN_ROUNDS} turda tamamlanmadı — havuzda en az ` +
            `${remaining} iş kaldı, bir sonraki normal turda devam edilecek. ` +
            "Bu bir hata değil, bilerek konmuş bir üst sınır: kontrolsüz bir döngü " +
            "admin yetkili bir hesapla çalışırken tehlikelidir.",
        );
        return;
      }
      if (Date.now() >= until) {
        log(
          `[keşif] havuz boşaltma 5 dakikalık üst sınıra ulaştı — havuzda en az ${remaining} ` +
            "iş kaldı, bir sonraki normal turda devam edilecek.",
        );
        return;
      }
    }
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
