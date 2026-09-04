import type {
  ApplicationRecord,
  DataClass,
  GateDecision,
  Locale,
  RiskTier,
  RoutingRule,
  RunId,
  StepId,
  TicketKey,
  WorkMode,
} from "@maestro/contracts";
import type { AuditChain } from "@maestro/audit";
import type { AgentTurnRequest, AgentTurnResult, CommandSpec } from "@maestro/execution";
import type { JournalDeps } from "@maestro/memory";
import type { EscalationLadder, NotifyRouting } from "@maestro/notify";
import type {
  LlmPort,
  NotifyPort,
  PublishPort,
  ScanPort,
  ScmPort,
  SecretPort,
  StoragePort,
  WorkPort,
} from "@maestro/ports";

/**
 * Everything an activity needs, as INTERFACES.
 *
 * M44: no concrete driver is named anywhere in this package — `worker.ts`
 * resolves them from the registry and hands the result in. That is also what
 * keeps the activity tests offline: the same seams take fakes.
 */

/**
 * What a run is, beyond its ticket key.
 *
 * Activities receive a `TicketKey` and nothing else (the workflow may not carry
 * mutable business state through its arguments), so every fact an activity
 * needs about the run is read back from here. The store is the run's row in the
 * database; in tests it is a Map.
 */
export interface RunContext {
  readonly runId: RunId;
  readonly ticket: TicketKey;
  /**
   * `null` for an analysis-only run: the binding carried no application, so
   * there is no repository, no branch that means anything, and no PR to open.
   * Intake only ever starts the `analiz` flow that way, and the workflow hands
   * over before the engineering half — so the code paths that NEED an app
   * (`delivery.ts`, fan-out's self-exclusion) treat `null` as "refuse loudly"
   * or "no self to exclude", never as a blank app to write into.
   */
  readonly app: ApplicationRecord | null;
  readonly dataClass: DataClass;
  readonly mode: WorkMode;
  readonly locale: Locale;
  /** Prompt-variant this run is pinned to (M38) — the ANALYST/intake agent. */
  readonly variantId: string;
  /**
   * The agent the ENGINEERING turn runs on, pinned at start beside `variantId`
   * (migration 0022).
   *
   * Empty string means "this deployment has no separate engineer agent, or this
   * run predates the pin" — and every reader must then use `variantId`, which
   * is exactly what every step did before this field existed. Use
   * `engineerVariantOf(run)` rather than reading it raw, so that fallback lives
   * in ONE place instead of at each of the four engineering call sites.
   *
   * Why it exists: `variantId` is planted by `activeAnalystVariantId`, which
   * asks for `role = 'analyst'` explicitly. Every later step read that one
   * value — the code-writing turn included — so an admin who defined a separate
   * engineer agent in "Ajan tanımları" (its own model, its own persona) had it
   * applied to nothing, silently. The pilot has resolved both agents since Faz 3;
   * the Temporal path, which is what a bank install actually runs, had half.
   */
  readonly engineerVariantId: string;
  /** Analysis template pinned at run start (M83). */
  readonly templateVersion: string;
  /**
   * The step the run is on, as Studio's ticket list reads it.
   *
   * Carried on the context because the WORKFLOW advances it (`goto`) while the
   * screens read it from Postgres: without a write path the two disagree, and
   * every run showed step 0 no matter how far it had got.
   */
  readonly step: string;
  /**
   * The run's lifecycle state as the ROW carries it. Studio's lists filter on
   * it, so a run Temporal has completed must say so here too — otherwise every
   * finished ticket keeps showing as live, and intake keeps joining a run that
   * is over instead of starting a new one.
   *
   * A union rather than `string`: the column is a Prisma enum, and the store's
   * own `notIn` filter is written against these names.
   *
   * `gate` and `handover` joined the union when `openGate` started writing the
   * row (`impl/gate.ts`). They were always legal values of the COLUMN — the
   * reconciler protects both by name (`stores/reconcile.ts`) and the demo data
   * has always carried `gate` — but the workflow could not write them, so a run
   * parked at a human gate stayed `running` in Postgres and Studio listed a
   * pending approval as work in progress.
   */
  readonly status: RunLifecycle;
  readonly workspacePath: string;
  /** False after an M65 archive — the clone is gone, the context is not. */
  readonly workspacePresent: boolean;
  /** The repo's ADDITIONS to the M52 deny-list, from `.maestro.yaml` (M71). */
  readonly protectedPaths: readonly string[];
  /** The repo's own lint/build/test commands (`.maestro.yaml`, M71). */
  readonly verification: readonly CommandSpec[];
  readonly branch: string;
  readonly targetBranch: string;
  readonly risk: RiskTier | null;
  readonly prId: number | null;
  /** Resume token of the live agent session (M30); null before the first turn. */
  readonly resumeToken: string | null;
  /**
   * ÖNCEKİ KOŞULARIN İŞİ — bu ticket bir kez daha denendiyse, orada ne olduğu.
   *
   * ── Neden var: operatörün şartı ───────────────────────────────────────────
   * "koşu ölse de GEÇMİŞ BİLGİLERİN ÖLMEMESİ lazım DB'den. koşu yeniden
   * başlayınca AI'IN ESKİ YAPILANLARI HATIRLAMASI lazım."
   *
   * Ölü bir koşu artık otomatik yeniden başlıyor (`jira-discovery.ts`), ve
   * emekliye ayırma hiçbir satırı silmiyor: defter, adım olayları, kanıt ve
   * kapı kayıtları `onUpdate: Cascade` ile emekli kimliğe TAŞINIYOR. Yani
   * geçmiş veritabanında duruyor — ama YENİ koşu onu GÖRMÜYORDU. Yeni bir
   * workflow execution'ın belleği boş: `state.analysis` gibi bellekte taşınan
   * bağlam ölen koşuyla birlikte gitti. Model sıfırdan başlıyor, aynı soruları
   * yeniden soruyor, aynı analizi yeniden üretiyor. Operatör için bu ilerleme
   * değil TEKRAR — ve otomatik yeniden başlatmayı anlamsız kılar.
   *
   * ── Neden BURADA (yeni bir aktivite DEĞİL) ────────────────────────────────
   * `AnalysisRewriteContext.previous` bilerek journal'dan değil BELLEKTEN
   * geliyor (`ticket-workflow.ts:602`): workflow kodu I/O yapamaz, ve her
   * bağlam için bir aktivite daha eklemek replay yüzeyini büyütürdü. Aynı
   * kısıt burada da geçerli, ama çözüm farklı olmak zorunda: yeniden başlayan
   * koşunun belleği YOK, dolayısıyla kaynak veritabanı olmalı.
   *
   * Çözüm yeni bir aktivite eklemek DEĞİL, VAR OLAN okumaya binmek: her
   * aktivite zaten `deps.runs.get(ticket)` ile bağlamını okuyor, ve o okuma
   * bir aktivitenin İÇİNDE oluyor — yani workflow determinizmine hiç
   * dokunmuyor. Mağaza satırı okurken emekli defterleri de okur ve özeti bu
   * alana koyar. Sıfır yeni aktivite, sıfır replay riski, aktivite başına bir
   * ek sorgu (yalnız emekli satırı OLAN ticket'larda).
   *
   * ── Neden ÖZET, ham defter değil ──────────────────────────────────────────
   * `impl/analysis.ts` `previousNote`in kurduğu disiplin: önceki analizin
   * TAMAMI değil, üç alanı gidiyor — "tamamını göndermek modele kopyalayacağı
   * bir şablon vermek olurdu; istenen yeniden DÜŞÜNMEK". Aynı gerekçe burada
   * daha da güçlü: bir koşunun defteri onlarca satır, ve gpt-oss gibi küçük
   * modeller uzun bağlamda zorlanır. Ham yığın modeli kör eder.
   *
   * `null` = bu ticket'ın emekli koşusu yok (ezici çoğunluk) ve hiçbir şey
   * prompta eklenmez — ilk koşu bugünkü davranışını bit bit korur.
   */
  readonly priorWork: PriorWork | null;
}

/**
 * ÖNCEKİ KOŞULARDAN TAŞINAN ÖZET — dört soru, dört cevap.
 *
 * Alanların seçimi keyfi değil: her biri yeniden başlayan bir koşunun
 * TEKRARLAYACAĞI bir işi engelliyor.
 *
 *  · `attempts`    — "kaçıncı denemedeyim": modelin aynı yaklaşımı üçüncü kez
 *                    denememesi için bilmesi gereken tek sayı.
 *  · `analysis`    — "daha önce ne yazmıştım": önceki analizin KİMLİĞİ
 *                    (risk + gerekçe), belgenin kendisi değil.
 *  · `questions`   — "neyi zaten sordum, ne cevap aldım": aynı netleştirme
 *                    sorusunu ikinci kez sormak, operatörün sahada gördüğü en
 *                    can sıkıcı tekrar.
 *  · `decisions`   — "insan neye hayır dedi ve neden": bir ret sebebini
 *                    bilmeden yeniden yazmak, reddedilen şeyi yeniden yazmak.
 */
export interface PriorWork {
  /** Bu ticket için daha önce kaç koşu emekliye ayrıldı. */
  readonly attempts: number;
  /** Önceki analizlerin son satırı — risk katmanı ve gerekçesi gibi kısa kimlik. */
  readonly analysis: readonly string[];
  /** Sorulan netleştirme soruları ve alınan cevaplar. */
  readonly questions: readonly string[];
  /** Kapı kararları: ret/geri gönderme ve sebepleri. */
  readonly decisions: readonly string[];
}

/**
 * The states `WorkflowRun.status` can hold that the WORKFLOW itself writes.
 *
 * Deliberately narrower than the contract's `WorkflowRunStatus`: `fail` and
 * `queued` are absent because nothing in this package may write them. `fail` is
 * the reconciler's verdict about a run that died (`stores/reconcile.ts`) — a
 * workflow that could still write is by definition not the thing that failed —
 * and `queued` belongs to the intake side. Keeping them out means a typo here
 * is a compile error rather than a row that quietly contradicts the engine.
 */
export type RunLifecycle = "running" | "gate" | "handover" | "done" | "cancelled";

export interface RunContextStore {
  get(ticket: TicketKey): Promise<RunContext>;
  patch(ticket: TicketKey, changes: Partial<RunContext>): Promise<void>;
}

/** One open (or closed) approval gate — the escalation ladder's anchor (M88). */
export interface GateRecord {
  readonly runId: RunId;
  readonly step: StepId;
  readonly ownerGroup: string;
  readonly openedAt: string;
  /** Ladder steps already sent; the ladder never fires the same one twice. */
  readonly firedStepIds: readonly string[];
  readonly closedAt: string | null;
}

export interface GateStore {
  /** Idempotent: re-opening an open gate returns the existing record. */
  open(runId: RunId, step: StepId, ownerGroup: string, at: string): Promise<GateRecord>;
  get(runId: RunId, step: StepId): Promise<GateRecord | null>;
  markFired(runId: RunId, step: StepId, stepIds: readonly string[]): Promise<void>;
  close(runId: RunId, step: StepId, at: string): Promise<void>;
  /** Approvers of already-closed gates — the evidence package's signature chain. */
  decisions(runId: RunId): Promise<GateDecision[]>;
}

/**
 * Operational settings (M71). All of them live in the database and are read
 * through here, so this package holds no second copy of any default.
 */
export interface ParamReader {
  escalationLadder(runId: RunId): Promise<EscalationLadder>;
  notifyRouting(runId: RunId): Promise<NotifyRouting>;
  routingRules(ticket: TicketKey): Promise<RoutingRule[]>;
  /** Publish targets for a document kind (M47). */
  publishTargets(runId: RunId, doc: "analysis" | "evidence_summary"): Promise<string[]>;
}

/** Who a notification goes to. Group → corporate addresses (M71). */
export interface DirectoryReader {
  membersOf(group: string): Promise<string[]>;
  /**
   * The directory group that answers to a workflow ROLE (`product-owners`,
   * `tech-leads`, `qa`).
   *
   * The two vocabularies are not the same, and pretending they are cost a live
   * gate: `GATE_OWNER` named `product-owners`, `openGate` wrote that onto the
   * gate record, and the BFF asked Jira about `jira-users-uyildiz` — the group
   * that actually exists. Both sides then verified a real approver against a
   * DIFFERENT group, the BFF said yes, the worker said "üyelik doğrulanamadı",
   * and a correct approval was refused with no way to tell why from either log.
   *
   * Resolving here means the group written onto the gate is the group the
   * decision is checked against, because it is one lookup instead of two
   * guesses. A deployment whose directory uses the role names needs no mapping.
   */
  groupForRole(role: string): Promise<string>;
}

/** One doing-role turn (`@maestro/execution`'s `AgentExecution`). */
export interface AgentTurnRunner {
  runTurn(req: AgentTurnRequest): Promise<AgentTurnResult>;
  endRun(runId: string): void;
}

/**
 * Temporal retries activities, so every write goes through here: the guard
 * remembers the key and replays the first result instead of writing twice.
 * Production backs it with a table; tests back it with a Map.
 */
export interface IdempotencyGuard {
  once<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/** Message-catalog lookup (M104), injected so this package owns no catalog. */
export type Translate = (locale: Locale, key: string, params?: Record<string, string>) => string;

/**
 * Putting a FILE on the ticket (M103r) — the analysis Word/PDF, so nobody has
 * to drag them in by hand.
 *
 * A seam rather than a `WorkPort` method, because `WorkPort` is FROZEN
 * (packages/ports) and attaching a binary is not part of it. The capability is
 * real on the concrete Jira Cloud driver (`addAttachment`), and the
 * composition root — the one place allowed to name a driver (M44) — passes
 * that method in. This package still imports nothing from an adapter: it
 * declares the SHAPE it needs and takes whatever satisfies it, which is also
 * what keeps the tests offline.
 *
 * OPTIONAL on purpose. A deployment on a driver with no attachment API (the DC
 * driver today) is a supported deployment: the documents are still generated
 * and still stored durably, and the delivery says in the journal that the
 * ticket did not get them. Making this required would either break those
 * deployments or force a no-op stub that lies about what happened.
 */
export interface DocAttacher {
  addAttachment(
    ticket: TicketKey,
    fileName: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ ids: string[] }>;
}

/**
 * Moving the ticket ITSELF — the desk-to-desk part of "dinleme kuralı" mode B.
 *
 * The same shape and the same reason as `DocAttacher` above: `WorkPort` is
 * FROZEN and its `transition()` takes a per-workflow transition ID, which is
 * meaningless outside the one project that issued it. What a listening rule
 * names is a STATUS ("İNCELEMEDE"), so the capability this package needs is
 * "move to the status called X" — real on the concrete Jira Cloud driver
 * (`transitionToStatus`), absent on Data Center. The composition root matches
 * the shape to a driver; this package imports no adapter.
 *
 * `move` NEVER throws, and that is the whole contract rather than a nicety: the
 * policy the ticket workflow was built for is "warn but continue". A status the
 * operator's board does not offer, a service account without Transition Issues,
 * a 5xx — none of them may cost a run whose analysis is finished and approved.
 * So the outcome comes back as data (`moved` plus a `reason`) and the caller
 * writes it into the journal, where an operator can read WHY the ticket stayed
 * where it was.
 *
 * OPTIONAL, like `DocAttacher`: a deployment on a driver that cannot transition
 * is a supported deployment. It stays in comment-only mode, which is exactly
 * what every rule did before the status map existed.
 */
export interface StatusMover {
  move(ticket: TicketKey, statusName: string): Promise<{ moved: boolean; reason?: string }>;
}

/**
 * Ticket'ın YORUM AKIŞINI okumak — netleştirme döngüsünü kıran şey.
 *
 * ── HANGİ BOŞLUĞU KAPATIYOR ─────────────────────────────────────────────────
 * Intake bugün yalnız `getTicket` snapshot'ını görüyor: özet, açıklama, tip.
 * Reporter'ın netleştirme sorusuna yazdığı CEVAP ise bir YORUM olarak duruyor,
 * snapshot'ta değil. Yani re-entry köprüsü koşuyu uyandırdığında intake yine
 * aynı ince ticket'ı okuyor, yine "eksik" diyor, yine aynı soruyu soruyor —
 * cevap yazılmış olmasına rağmen. Sonsuz iade döngüsü, ve reporter'ın gördüğü
 * tek şey botun kendi sorusunu tekrar etmesi.
 *
 * ── NEDEN AYRI BİR SEAM, `WorkPort` METODU DEĞİL ────────────────────────────
 * `WorkPort` DONMUŞ, ve `listComments` zaten bilinçli olarak dışında: port
 * akışın İHTİYACI olanı taşır, bir yorum dizisini okumak da o değildi (motor
 * sinyalle uyandırılır, bakmaz). Yetenek somut Jira sürücülerinde duruyor —
 * DC'de `listComments` (poller için eklendi), Cloud'da aynı ad. `DocAttacher`
 * ve `StatusMover` ile birebir aynı şekil ve aynı gerekçe: bu paket ihtiyaç
 * duyduğu ŞEKLİ bildirir, kompozisyon kökü onu karşılayan sürücüyü verir.
 *
 * ── HAM `unknown[]` DÖNMESİ BİLEREK ─────────────────────────────────────────
 * İki sürücü aynı şeyi iki farklı LEHÇEDE söylüyor: Cloud (REST v3) gövdeyi ADF
 * belgesi olarak, yazarı `accountId` ile verir; Data Center (REST v2) gövdeyi
 * düz wiki-markup STRING, yazarı `name`/`key`/`emailAddress` ile. Burada bir
 * ortak tip dayatmak, iki lehçeden birini sürücü dışında yeniden çözmek olurdu.
 * Ayıklama `comments.ts` içinde, iki lehçeyi de tanıyan tek bir yerde yapılıyor.
 *
 * ── OPSİYONEL ───────────────────────────────────────────────────────────────
 * Bağlı değilse intake bugünkü gibi yalnız snapshot'ı görür — yani bu satır
 * eklenmeden önceki davranış, aynen. Okuma PATLARSA da akış düşmez: yorumsuz
 * devam eder (bkz. `readHumanComments`).
 */
export interface CommentReader {
  /** Ticket'ın yorum kaynakları, sürücünün ham şekliyle. */
  listComments(ticket: TicketKey): Promise<unknown[]>;
  /**
   * Maestro'nun KENDİ yazdığı yorumları elemek için bot hesabının kimliği;
   * bilinmiyorsa `undefined`.
   *
   * Bilinmemesi kabul edilebilir bir cevap: o zaman bot yorumları elenmez ve
   * intake kendi sorduğu soruyu da bağlamda görür. Bu, hiç yorum görmemekten
   * iyidir — soru zaten ticket'ta duruyor — ama ideal değil, ve `undefined`
   * olduğunda `comments.ts` bunu açıkça bir uyarı satırıyla söyler.
   */
  readonly botUserId?: string;
}

/**
 * The PERSONA an admin typed into Studio's "Ajan tanımları" ekranı, per agent.
 *
 * ── HANGİ BOŞLUĞU KAPATIYOR ─────────────────────────────────────────────────
 * `VariantVersion.configJson.persona` alanı Studio'da yazılıyor, veritabanına
 * yazılıyor, `/variants` ile geri okunuyor — ve akışa HİÇ ulaşmıyordu. Bu
 * paketin tamamında "persona" kelimesi geçmiyordu: pilot personayı okuyup
 * analize ilk bilgi notu olarak veriyordu (`apps/pilot/src/run.ts`), Temporal
 * yolu ise — bankanın gerçekten çalıştırdığı yol — hiç okumuyordu. Yani admin
 * ajanının nasıl davranacağını yazıyor, model onu hiç görmüyordu.
 *
 * ── NEDEN AYRI BİR SEAM, `ParamReader`'a EKLENMİŞ BİR METOT DEĞİL ───────────
 * `DocAttacher`/`StatusMover` ile aynı gerekçe: bu paket hiçbir sürücüyü ve
 * `@maestro/db`'yi adlandırmaz (M44). İhtiyaç duyduğu ŞEKLİ bildirir, kompozisyon
 * kökü (`apps/deploy`) onu karşılayan bir şey verir — `PrismaVariantModelReader`
 * zaten `activePersona`'yı yapısal olarak karşılıyor. Testleri çevrimdışı tutan
 * da bu.
 *
 * ── NEDEN OPSİYONEL ─────────────────────────────────────────────────────────
 * Bağlanmamışsa her rol, kurumun `packages/agent-roles`'daki varsayılan
 * promptuyla çalışır — yani bugünkü davranış, aynen. Persona bir ÜST KATMANDIR
 * (overlay), rolün promptunun yerine geçmez.
 */
export interface PersonaReader {
  /**
   * `variantId`'nin yayınlanmış (en yeni) sürümündeki persona metni; yoksa
   * `null`. `null` gerçek bir cevaptır: "bu ajan için persona yazılmamış" —
   * çağıran overlay eklemez ve akış aynen devam eder.
   *
   * Bu metot ATMAMALIDIR. Bir persona okuması, analizi ya da kod turunu
   * düşürmeye değecek bir şey değil: uygulaması (`personaReaderFrom`) okuma
   * hatasını yutar ve `null` döner, ama bunu GÖRÜNÜR bir uyarı satırıyla yapar.
   */
  activePersona(variantId: string): Promise<string | null>;
}

export interface ActivityDeps {
  readonly runs: RunContextStore;
  readonly gates: GateStore;
  readonly params: ParamReader;
  readonly directory: DirectoryReader;
  readonly work: WorkPort;
  readonly scm: ScmPort;
  readonly llm: LlmPort;
  readonly scan: ScanPort;
  readonly storage: StoragePort;
  /**
   * D5: resolved and wired, but no activity in this package reads it yet. It
   * stays because the push credential the engineering turn needs (`scm`'s
   * `getPushCredential`) is issued through it, and the seam is what keeps that
   * a composition-root decision rather than a driver import. Delete it only
   * together with that plan.
   */
  readonly secrets: SecretPort;
  readonly notify: NotifyPort;
  readonly publish: PublishPort;
  readonly memory: JournalDeps;
  readonly execution: AgentTurnRunner;
  readonly audit: AuditChain;
  readonly idempotency: IdempotencyGuard;
  /**
   * Absent on a deployment whose work driver cannot attach files (M103r). The
   * analysis documents are then generated and stored, but not put on the
   * ticket — and the journal says so.
   */
  readonly docAttacher?: DocAttacher;
  /**
   * Absent on a deployment whose work driver cannot move a ticket between
   * statuses. The flow then runs exactly as it always has — comments only — and
   * the journal says the move was skipped for want of the capability.
   */
  readonly statusMover?: StatusMover;
  /**
   * Studio'da tanımlanan ajan personası (yukarıdaki `PersonaReader`). Absent =
   * her rol kurumun `agent-roles` varsayılan promptuyla çalışır, bugünkü
   * davranışın aynısı.
   */
  readonly persona?: PersonaReader;
  /**
   * Ticket'ın yorum akışı (yukarıdaki `CommentReader`). Absent = intake yalnız
   * snapshot'ı görür, bugünkü davranış — ve netleştirme cevapları görünmez.
   */
  readonly comments?: CommentReader;
  readonly translate: Translate;
  readonly now: () => Date;
}

/**
 * Which agent the ENGINEERING half of a run speaks as.
 *
 * One function rather than an inline `?:` at each engineering call site, and
 * that is the whole point: the fallback ("no engineer pin → the analyst's
 * variant") is the pre-migration behaviour, and a fallback copied into four
 * places is a fallback that will one day disagree with itself. A run opened
 * before migration 0022 carries `""` here and reads exactly as it always did.
 *
 * The ANALYSIS half keeps using `run.variantId` directly — it is the analyst's
 * pin by construction (`activeAnalystVariantId`), and routing it through a
 * helper would suggest a choice that is not being made.
 */
export function engineerVariantOf(run: RunContext): string {
  const engineer = run.engineerVariantId.trim();
  return engineer === "" ? run.variantId : engineer;
}

/** Actor recorded on everything the worker writes (M33 actor conventions). */
export const WORKER_ACTOR = "maestro-worker";
