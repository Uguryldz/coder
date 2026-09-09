import type { ApplicationRecord } from "@maestro/contracts";
import type { PriorWork, RunContext, RunContextStore } from "@maestro/workflows";

/**
 * `CommandSpec`, taken from the interface rather than imported.
 *
 * The type lives in `@maestro/execution`, which this package does not depend
 * on and should not start depending on for one structural shape. Deriving it
 * from `RunContext` is also strictly safer: if the contract's verification
 * shape changes, this alias changes with it and the mapper below stops
 * compiling, which is exactly the notification we want.
 */
type CommandSpec = RunContext["verification"][number];

/**
 * The Postgres-backed `RunContextStore` (Dalga 5).
 *
 * M44 clean room: `@maestro/workflows` defines the interface and never imports
 * Prisma — its activity tests all run offline against a Map. This is the real
 * one, and it lives in the composition root for the same reason
 * `PrismaUserDirectory` does: the package that owns the interface must stay
 * free of the driver.
 *
 * The delegate is structural rather than `PrismaClient["workflowRun"]`. That is
 * the house pattern (see `users.ts`) and it buys two things: this file
 * typechecks before `prisma generate` has run, and the four methods below are a
 * written-down statement of exactly how much of the table this store may touch.
 */

/** The `WorkflowRun` row as read back, joined to its application. */
export interface RunRow {
  id: string;
  ticketKey: string;
  /**
   * The FK, read alongside the joined row so `get` can tell two nulls apart:
   * `appId === null` is an analysis-only run (the binding named no
   * application, deliberately), while `appId !== null` with a `null` join is a
   * row pointing at an application that is gone — the incomplete-context
   * failure it has always been.
   */
  appId: string | null;
  step: string;
  /**
   * Read as a plain `string`, not the narrowed union.
   *
   * The WRITE side (`RunUpdate`) is narrow so a typo cannot reach the column,
   * but the read side takes whatever the row holds: Prisma's generated enum is
   * its own type, and narrowing here makes the real delegate structurally
   * incompatible with this interface for no safety the database is not already
   * enforcing.
   */
  status: string;
  mode: string;
  risk: string | null;
  dataClass: string;
  locale: string;
  variantId: string;
  engineerVariantId: string;
  templateVersion: string;
  workspacePath: string;
  workspacePresent: boolean;
  protectedPathsJson: unknown;
  verificationJson: unknown;
  branch: string;
  targetBranch: string;
  prId: number | null;
  resumeToken: string | null;
  application: ApplicationRow | null;
}

export interface ApplicationRow {
  appId: string;
  displayName: string;
  adoProject: string;
  adoRepo: string;
  platform: string;
  jiraComponent: string | null;
  maestroYamlPresent: boolean;
  createdVia: string;
}

/**
 * The columns `patch` may write. Every one is optional — that is the point.
 *
 * `risk` is typed as the contract's tier union rather than `string` because
 * the column is a Prisma enum; see `TERMINAL_STATUSES` for why that strictness
 * is the useful kind.
 */
export interface RunUpdate {
  /** The step the workflow has reached; Studio's ticket list reads this column. */
  step?: string;
  /**
   * The run's lifecycle state. Written when the workflow ENDS: `get` filters on
   * `status notIn TERMINAL_STATUSES`, so a finished run that never sets this
   * stays "live" forever and the ticket can never start a second run.
   */
  status?: NonNullable<RunContext["status"]>;
  risk?: NonNullable<RunContext["risk"]>;
  locale?: string;
  variantId?: string;
  engineerVariantId?: string;
  templateVersion?: string;
  workspacePath?: string;
  workspacePresent?: boolean;
  protectedPathsJson?: string[];
  /**
   * The verification commands as WRITTEN. `CommandSpec`'s own fields are
   * `readonly`, and Prisma's JSON input type rejects that — reasonably, since
   * it serialises the value. The write shape is the same data with mutable
   * fields, which is also the shape `parseCommands` validates on the way back.
   */
  verificationJson?: Array<{ name: string; command: string[] }>;
  branch?: string;
  targetBranch?: string;
  prId?: number | null;
  resumeToken?: string | null;
}

/**
 * The columns `create` writes.
 *
 * Deliberately smaller than `RunUpdate`: everything the run learns LATER —
 * branch, workspace, risk, prId, resumeToken — is left to the schema defaults
 * and filled by `patch` as the workflow discovers it. Writing invented values
 * here would put a branch name in the row before anything created a branch.
 *
 * `appId` is nullable in the schema (M99), and since analysis-only bindings it
 * is genuinely OPTIONAL here too: intake starts an `analiz` run with no
 * application when the binding named none, and the column honestly stays NULL.
 * Omitted rather than written as an explicit null so a caller that HAS an app
 * writes exactly the row it always wrote.
 */
export interface RunCreate {
  id: string;
  ticketKey: string;
  appId?: string;
  mode: NonNullable<RunContext["mode"]>;
  dataClass: NonNullable<RunContext["dataClass"]>;
  step: string;
  /**
   * Literal rather than `string`, for the reason `TERMINAL_STATUSES` gives:
   * the column is a Prisma enum and the generated client rejects a widened
   * `string`. A run opens `running` and nothing else, so the type says so —
   * a typo'd status is then a compile error rather than a row the store's own
   * `notIn` filter would never match.
   */
  status: "running";
  startedAt: Date;
  locale?: string;
  variantId?: string;
  /**
   * Optional here where `variantId` is effectively required, and that asymmetry
   * is deliberate: the column defaults to `""`, and `""` has a DEFINED meaning
   * for this one ("no separate engineer agent → use the analyst's", see
   * `engineerVariantOf`). An empty `variantId` has no such meaning — it is a
   * wiring bug — which is why `assertPinned` refuses that one and not this one.
   */
  engineerVariantId?: string;
  templateVersion?: string;
  workspacePath?: string;
  workspacePresent?: boolean;
}

/** The three `PrismaClient.workflowRun` methods this store uses, and no more. */
export interface RunDelegate {
  findFirst(args: {
    where: { ticketKey: string; status: { notIn: TerminalStatus[] } };
    orderBy: { startedAt: "desc" };
    include: { application: true };
  }): Promise<RunRow | null>;
  update(args: { where: { id: string }; data: RunUpdate }): Promise<unknown>;
  create(args: { data: RunCreate }): Promise<unknown>;
  /**
   * Bu ticket'ın ŞİMDİYE KADAR kullandığı kimlikler — yeni koşuya boş bir ad
   * seçebilmek için.
   *
   * Emekliye ayırma artık satırın kimliğine DOKUNMUYOR (bkz.
   * `PrismaRunCatalog.retire`: kimlik değiştirmek `JournalEntry.runId`'yi
   * cascade ile UPDATE ettiriyordu ve o tablo yalnızca-ekleme korumalı, yani
   * veritabanı reddediyordu). Bunun bedeli, emekli satırın `maestro-<ticket>`
   * kimliğini TUTMAYA devam etmesi: yeni koşu aynı kimlikle satır açamaz.
   *
   * Bu yüzden yazan taraf ticket'ın kimliklerini okuyup kullanılmamış olanı
   * seçiyor. `select: { id: true }` — bir ticket'ın koşu sayısı tek haneli, ve
   * kimlikten başka bir şey okumak bu delegenin sözünü genişletirdi.
   */
  findMany(args: {
    where: { ticketKey: string };
    select: { id: true };
  }): Promise<Array<{ id: string }>>;
}

/**
 * EMEKLİ DEFTER SATIRLARINI OKUYAN DELEGE — "AI eski yapılanları hatırlasın".
 *
 * `JournalEntry.runId` bu ticket'ın emekli koşularının kimliğini taşıyor
 * (`maestro-<ticket>`, sonraki koşularda `maestro-<ticket>-2`, …), çünkü
 * emekliye ayırma satırı ne siliyor ne de adını değiştiriyor: yalnız statüsünü
 * terminale çekip arşiv damgası basıyor. Defter yazıldığı kimlikte, olduğu
 * yerde duruyor; bu delege onu okuyan yüzey.
 *
 * `RunDelegate` ile aynı desen ve aynı gerekçe: mağaza tablonun ne kadarına
 * dokunduğunu YAZILI olarak söylüyor. Tek bir `findMany`, ve `where` yalnız
 * `runId in (...)` + `kind in (...)` — koşunun defterinin TAMAMI değil, özete
 * girecek dört tür.
 */
export interface JournalDelegate {
  findMany(args: {
    where: { runId: { in: string[] }; kind: { in: JournalKind[] } };
    orderBy: { at: "desc" };
    take: number;
    select: { kind: true; title: true; detail: true; actor: true };
  }): Promise<Array<{ kind: string; title: string; detail: string; actor: string }>>;
}

/** Emekli KOŞU satırlarını bulan delege — özet hangi kimliklerden okunacak. */
export interface RetiredRunDelegate {
  findMany(args: {
    where: { ticketKey: string; archivedAt: { not: null } };
    orderBy: { archivedAt: "desc" };
    take: number;
    select: { id: true };
  }): Promise<Array<{ id: string }>>;
}

/**
 * ÖZETE GİREN DEFTER TÜRLERİ — ve neden yalnız bu üçü.
 *
 * `analysis` "daha önce ne yazmıştım", `clarification` "neyi zaten sordum",
 * `gate` "insan neye hayır dedi". Diğer on beş tür (ci, pr, scan, test_run…)
 * yeniden başlayan bir koşunun TEKRARLAMAYACAĞI işler: onlar mühendislik
 * turunun çıktıları, ve yeni koşu o adımlara ulaşmadan önce zaten baştan
 * karar verecek. Prompta koymak, modeli okumayacağı satırlarla doldurmak
 * olurdu — küçük modellerde doğrudan zarar.
 */
const PRIOR_WORK_KINDS = ["analysis", "clarification", "gate"] as const;
export type JournalKind = (typeof PRIOR_WORK_KINDS)[number];

/**
 * KAÇ EMEKLİ KOŞU, KAÇ SATIR — bağlam sınırının iki rakamı.
 *
 * Üç emekli koşu: otomatik yeniden başlatmanın kendi freni de üçte duruyor
 * (`jira-discovery.ts` `maxAutoRestarts`), yani daha fazlası zaten insana
 * devredilmiş bir ticket demek.
 *
 * Otuz satır: üç türün üç koşu boyunca toplamı. Daha fazlası gpt-oss gibi
 * küçük modellerde bağlamı boğar, ve `previousNote`in "ilk beş kabul kriteri"
 * kararıyla aynı disiplin — özet, döküm değil.
 */
const PRIOR_RUN_LIMIT = 3;
const PRIOR_ENTRY_LIMIT = 30;

/** Bir türden özete kaç satır girer — tek bir tür diğerlerini boğmasın. */
const PER_KIND_LIMIT = 5;

/**
 * Statuses that mean "this run is over". `get` reads the newest run that is
 * NOT one of them, which is the same definition of "live" the partial unique
 * index uses (migration 0002, widened by 0011) — one place to change it, and
 * the store and the database agree on which run a ticket means.
 *
 * `fail` joined the set in 0011, and it had to join both halves at once. Until
 * then nothing ever wrote the status, so the omission was invisible; the
 * reconciler (`reconcile.ts`) writes it, and a `fail` row that still counted as
 * live would have been the worse bug of the two — the ticket's live slot stays
 * occupied, so `get` keeps handing activities a dead run's context and the next
 * `/ai-start` on that ticket dies on the unique index with P2002. A failed run
 * is over. Re-running it is the whole point of noticing it failed.
 *
 * The literal type is load-bearing: `WorkflowRun.status` is a Prisma enum, and
 * a `string[]` filter is rejected by the generated client. That rejection is
 * welcome — it is what stops a typo'd status from becoming a filter that
 * silently matches nothing and makes every run look live.
 */
export const TERMINAL_STATUSES = ["done", "cancelled", "fail"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/**
 * What intake knows when a run opens, and nothing more.
 *
 * Mirrors `SignalWithStartInput` (`apps/bff/src/gateway.ts`) plus the ids
 * Temporal minted, so the caller passes through what it already has rather
 * than assembling a `RunContext` it cannot yet fill.
 */
export interface NewRun {
  readonly runId: string;
  readonly ticket: string;
  /**
   * `null` for an analysis-only run — the binding named no application, so
   * there is no repository, no checkout and no engineering half. Mirrors
   * `OpenedRun.appId` (the gateway hands intake's answer straight through).
   */
  readonly appId: string | null;
  readonly mode: NonNullable<RunContext["mode"]>;
  readonly dataClass: NonNullable<RunContext["dataClass"]>;
  readonly startedAt: Date;
  readonly locale?: string;
  /**
   * The prompt variant and analysis template this run is PINNED to (M38/M83).
   *
   * Both are pinned at the start rather than read per activity, so publishing a
   * new agent version mid-run cannot change the rules under a ticket that is
   * already being analysed — and the document a reviewer approves is the one
   * the run was configured to produce.
   *
   * They are required, not optional. The column defaults to `""`, and an empty
   * variant reaches the gateway as a contract violation on the FIRST model
   * call: `variantId: Too small: expected string to have >=1 characters`,
   * three activity attempts deep, where it reads as a model problem rather
   * than a run that was opened without saying which agent it runs.
   */
  readonly variantId: string;
  /**
   * The ENGINEER agent this run is pinned to (migration 0022), when the
   * deployment has one. Optional and defaulting to `""` — see `RunCreate`'s
   * note for why an empty one is a real answer here and not for `variantId`.
   */
  readonly engineerVariantId?: string;
  readonly templateVersion: string;
  /**
   * The checkout step 3ö reads (M100), when there is one.
   *
   * Optional because the analysis is worse without a repository but not wrong:
   * `discoverRepo` treats an unavailable session as degraded and the analyst
   * carries on from the ticket alone — which is exactly what the pilot has
   * always done. A clone that failed must not stop a ticket from being
   * analysed.
   */
  readonly workspacePath?: string;
  /** The PR's target (environment) branch; absent = "" until something sets it. */
  readonly targetBranch?: string;
}

/**
 * Prisma's unique-constraint failure, recognised without importing the client.
 *
 * This package's stores are structural over their delegates (see `RunDelegate`)
 * so that they typecheck before `prisma generate` has run; importing
 * `PrismaClientKnownRequestError` for one error code would give that up. P2002
 * is the documented code and is stable across Prisma 5/6.
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

export class RunNotFoundError extends Error {
  constructor(ticket: string) {
    super(`run context: no live run for ticket ${ticket}`);
    this.name = "RunNotFoundError";
  }
}

export class IncompleteRunContextError extends Error {
  constructor(ticket: string, missing: string) {
    super(`run context: run for ticket ${ticket} has no ${missing}`);
    this.name = "IncompleteRunContextError";
  }
}

/**
 * A run opened without saying which agent — or which template — it runs on.
 *
 * Raised at the moment the row would be WRITTEN, which is the last place the
 * mistake is still cheap. The alternative is the failure this deployment
 * actually produced: `variantId: ""` is accepted here (the column defaults to
 * `""`, and `RunCreate.variantId` is optional), and surfaces ~19 activity
 * attempts later inside `LlmGateway.generateObject` as
 * `ZodError: variantId: Too small: expected string to have >=1 characters` —
 * a message that reads as a model problem and names neither the run nor the
 * caller that opened it. OPS-22 and OPS-23 died exactly that way.
 *
 * Fail-closed rather than defaulting HERE is deliberate. `run-pins.ts` already
 * owns the fallback (`DEFAULT_ANALYST_VARIANT`), and it can pick a sensible one
 * because it knows the deployment's variants. A second, silent default in the
 * store would paper over a miswired composition root and pin real bank tickets
 * to an agent nobody chose — the store's job is to refuse the row, not to guess
 * what it should have contained.
 */
export class UnpinnedRunError extends Error {
  constructor(ticket: string, missing: "variantId" | "templateVersion") {
    super(
      `run context: refusing to open run for ticket ${ticket} with an empty ${missing} — ` +
        `it is pinned at start (M38/M83) and an empty one fails the LLM gateway's contract ` +
        `on the first model call`,
    );
    this.name = "UnpinnedRunError";
  }
}

export class PrismaRunContextStore implements RunContextStore {
  /**
   * `history` OPSİYONEL, ve bu bilinçli: onsuz mağaza bugüne kadar nasıl
   * davranıyorsa öyle davranır (`priorWork: null`, prompta hiçbir şey
   * eklenmez). Var olan çağıranlar ve testler değişmeden çalışsın diye —
   * `boundProjects` seam'iyle aynı duruş.
   */
  constructor(
    private readonly runs: RunDelegate,
    private readonly history?: {
      readonly retired: RetiredRunDelegate;
      readonly journal: JournalDelegate;
    },
  ) {}

  /**
   * Fail-closed on both halves.
   *
   * No live run is an error rather than an empty context: an activity that
   * gets `{}` back would carry on with an invented branch name and an empty
   * app, and the first thing it does with either is write to a bank's repo.
   *
   * The application half distinguishes two nulls. A row whose `appId` IS set
   * but whose join came back empty points at an application that no longer
   * exists — the incomplete-context failure it has always been, and inventing
   * a blank `ApplicationRecord` for it would send the engineering turn at
   * repo "". A row whose `appId` is itself null is an analysis-only run: the
   * binding named no application on purpose, `RunContext.app` is honestly
   * `null`, and the activities that need an app refuse for themselves
   * (`appOf` in `impl/delivery.ts`).
   */
  async get(ticket: string): Promise<RunContext> {
    const row = await this.liveRun(ticket);
    if (row === null) throw new RunNotFoundError(ticket);
    if (row.appId !== null && row.application === null) {
      throw new IncompleteRunContextError(ticket, "application");
    }
    return { ...toRunContext(row, row.application), priorWork: await this.priorWork(ticket) };
  }

  /**
   * ÖNCEKİ KOŞULARIN ÖZETİ — emekli defterlerden okunur, ya da `null`.
   *
   * ── Maliyet ───────────────────────────────────────────────────────────────
   * Emekli satırı OLMAYAN bir ticket'ta bir sorgu (ve o sorgu boş döner, yani
   * ikincisi hiç yapılmaz). Emekli satırı olan ticket'ta iki sorgu. Ezici
   * çoğunluk birincisi: bir ticket'ın yeniden başlatılması istisna, kural
   * değil.
   *
   * ── ASLA ATMAZ ────────────────────────────────────────────────────────────
   * Geçmişi okuyamamak, koşuyu durdurmak için bir sebep değil: bağlamsız bir
   * koşu, hiç koşu olmamasından iyidir. Hata yutulur ve `null` dönülür — yani
   * adım bu alan var olmadan önceki davranışına düşer. Aynı kural
   * `readHumanComments`te de geçerli (`impl/comments.ts`) ve aynı gerekçeyle.
   */
  private async priorWork(ticket: string): Promise<PriorWork | null> {
    if (this.history === undefined) return null;
    try {
      const retired = await this.history.retired.findMany({
        where: { ticketKey: ticket, archivedAt: { not: null } },
        orderBy: { archivedAt: "desc" },
        take: PRIOR_RUN_LIMIT,
        select: { id: true },
      });
      if (retired.length === 0) return null;

      const entries = await this.history.journal.findMany({
        where: {
          runId: { in: retired.map((row) => row.id) },
          kind: { in: [...PRIOR_WORK_KINDS] },
        },
        // En TAZE önce: sınıra takılırsak kaybedilen satırlar en eskiler olur,
        // yani modelin en az ihtiyaç duyduğu olanlar.
        orderBy: { at: "desc" },
        take: PRIOR_ENTRY_LIMIT,
        select: { kind: true, title: true, detail: true, actor: true },
      });

      const pick = (kind: string): string[] =>
        entries
          .filter((entry) => entry.kind === kind)
          .slice(0, PER_KIND_LIMIT)
          .map((entry) => {
            const detail = entry.detail.trim();
            // Başlık + ayrıntı, ayrıntı VARSA. Ayrıntı defterin uzun yarısı;
            // kırpılması gerekiyor ki tek bir kayıt özeti ele geçirmesin.
            return detail === ""
              ? entry.title
              : `${entry.title}: ${detail.length > 300 ? `${detail.slice(0, 300)}…` : detail}`;
          });

      return {
        attempts: retired.length,
        analysis: pick("analysis"),
        questions: pick("clarification"),
        decisions: pick("gate"),
      };
    } catch {
      return null;
    }
  }

  /**
   * Open the run's row. Called once, by intake, when Temporal reports that
   * `signalWithStart` actually STARTED an execution (`apps/bff/src/jira-intake.ts`).
   *
   * Every activity reads its context back from this row, so without it the
   * first activity of the first real run fails with `RunNotFoundError` — which
   * is precisely the state this deployment was in: a worker polling an empty
   * task queue because nothing ever wrote a run.
   *
   * Idempotent by intent, not by hope. Two webhook deliveries racing on one
   * ticket both reach here after Temporal has already collapsed them into one
   * execution, so both would try to insert. The pre-check makes the second one
   * a no-op; the partial unique index from migration 0002 is what makes it
   * SAFE, since it rejects a second live row even if both callers pass the
   * check simultaneously. Catching that rejection is deliberate: a unique
   * violation here means the row exists, which is the outcome the caller wanted.
   */
  async create(input: NewRun): Promise<void> {
    // Before the idempotency check, not after: a caller that passes an empty
    // pin has a wiring bug whether or not a row already exists, and letting the
    // second delivery of a webhook return quietly would hide it on exactly the
    // retry that made it reproducible.
    assertPinned(input);
    if ((await this.liveRun(input.ticket)) !== null) return;
    /**
     * BU KOŞUNUN SATIR KİMLİĞİ — çağıranın istediği ad, ya da boş olanı.
     *
     * `input.runId` motorun iş akışı kimliği (`maestro-<ticket>`) ve ilk koşuda
     * satır tam olarak onu alıyor — bugüne kadarki davranışın aynısı, ve
     * ticket'ların ezici çoğunluğu hiç yeniden başlatılmadığı için pratikte
     * TEK davranış.
     *
     * Yeniden başlatılmış bir ticket'ta ise o ad DOLU: emekli koşu kendi
     * kimliğini koruyor (bkz. `PrismaRunCatalog.retire` — kimliği değiştirmek
     * defterin yalnızca-ekleme korumasına çarpıyordu). O yüzden bu satır boş
     * bir ad alıyor. Kimlik ÜRETİLMİYOR, SEÇİLİYOR: ticket'ın mevcut adlarına
     * bakılıp ilk boş sıra numarası kullanılıyor.
     */
    const runId = await this.freeRunId(input.ticket, input.runId);
    try {
      await this.runs.create({
        data: {
          id: runId,
          ticketKey: input.ticket,
          // Omitted, not written as null, for an analysis-only run: the column
          // stays at its schema default and a run that HAS an app writes the
          // exact row it always wrote.
          ...(input.appId === null ? {} : { appId: input.appId }),
          mode: input.mode,
          dataClass: input.dataClass,
          // The workflow's own first step and status. Anything else here would
          // make the row disagree with the execution it describes.
          step: "0",
          status: "running",
          startedAt: input.startedAt,
          variantId: input.variantId,
          templateVersion: input.templateVersion,
          // Omitted rather than written as `""` when absent, so a run opened by
          // a caller that predates the engineer pin writes the exact row it
          // always wrote and the column keeps its schema default.
          ...(input.engineerVariantId === undefined || input.engineerVariantId.trim() === ""
            ? {}
            : { engineerVariantId: input.engineerVariantId }),
          ...(input.locale === undefined ? {} : { locale: input.locale }),
          ...(input.workspacePath === undefined
            ? {}
            : { workspacePath: input.workspacePath, workspacePresent: true }),
          ...(input.targetBranch === undefined || input.targetBranch.trim() === ""
            ? {}
            : { targetBranch: input.targetBranch.trim() }),
        },
      });
    } catch (error) {
      // Only the race is tolerated. Any other failure — a dead connection, a
      // constraint this code does not know about — must reach the caller, or
      // intake reports a started run that has no row and the failure surfaces
      // one activity later as "no live run".
      if (!isUniqueViolation(error)) throw error;
    }
  }

  /**
   * Ticket'ın KULLANILMAMIŞ bir koşu kimliği.
   *
   * İlk koşuda `wanted`ın kendisi (`maestro-<ticket>`) — yani bu işlev var
   * olmadan önceki davranış, harfi harfine. Yeniden başlatılmış bir ticket'ta
   * emekli satır o adı koruduğu için `-2`, `-3`, … diye ilk boş sıra.
   *
   * ── Neden `-2` ve `#emekli-<damga>` DEĞİL ────────────────────────────────
   * Kimlik yalnız bir birincil anahtar değil, bir DEPOLAMA YOLU parçası:
   * kanıt paketi anahtarları `evidence/<yıl>/<ticket>/<runId>/…` biçiminde ve
   * `RunId` (`@maestro/contracts`) bu yüzden alfabeyi `[A-Za-z0-9._-]` ile
   * sınırlıyor. `#` o alfabede YOK — eski emeklilik kimliği (`…#emekli-…`)
   * bir defter ya da kanıt satırı yazılmaya kalksaydı zod'da patlardı; emekli
   * satırlar terminal olduğu için pratikte yazılmıyordu, yani hata sadece
   * saklanıyordu. Sıra numarası hem o alfabede hem okunur: bir denetçi
   * `maestro-OTYT-1-2`yi "OTYT-1'in ikinci koşusu" diye okur.
   *
   * ── Neden zaman damgası değil, SIRA ──────────────────────────────────────
   * Damga her çağrıda farklı bir ad üretir, yani bir yarışta iki çağıran iki
   * AYRI satır açardı ve ikisi de "başarılı" olurdu. Sıra numarası ticket'ın
   * mevcut adlarından türediği için iki çağıran AYNI adı seçer ve birincil
   * anahtar yarışı veritabanında çözülür — `create`in zaten yuttuğu P2002,
   * "satır zaten var" anlamına gelir ve çağıranın istediği sonuç odur.
   *
   * Sıra, sayıya değil DOLULUĞA bakıyor: silinmiş bir satır ("3 var, 2 yok")
   * bir daha kullanılmasın diye değil — silme zaten yasak — ama elle
   * arşivlenmiş ya da reconcile'ın kapattığı satırların sayısıyla adların
   * sırası birbirinden ayrılabilir, ve ad çakışması sessiz bir yutulmaya
   * dönüşür.
   */
  private async freeRunId(ticket: string, wanted: string): Promise<string> {
    const taken = new Set(
      (await this.runs.findMany({ where: { ticketKey: ticket }, select: { id: true } })).map(
        (row) => row.id,
      ),
    );
    if (!taken.has(wanted)) return wanted;
    // 2'den başlıyor: `wanted`ın kendisi ticket'ın BİRİNCİ koşusu.
    for (let attempt = 2; attempt <= taken.size + 2; attempt += 1) {
      const candidate = `${wanted}-${attempt}`;
      if (!taken.has(candidate)) return candidate;
    }
    // Ulaşılamaz: döngü `taken.size + 1` aday deniyor ve o kadar dolu ad yok.
    // Yine de bir ad dönmek, `undefined` bir kimlikle satır açmaktan iyidir.
    return `${wanted}-${taken.size + 2}`;
  }

  /**
   * Partial update: a field the caller did not name is left alone.
   *
   * `undefined` is Prisma's "do not touch this column", so the mapping below
   * must never turn an absent key into an explicit value. `prId` and
   * `resumeToken` are the two that can be set BACK to null deliberately, so
   * they are forwarded when present and only then — which is why the
   * `in`-checks below are not the same as a truthiness test.
   */
  async patch(ticket: string, changes: Partial<RunContext>): Promise<void> {
    const row = await this.liveRun(ticket);
    if (row === null) throw new RunNotFoundError(ticket);

    const data = toRunUpdate(changes);
    // Nothing to write is not an error — a caller that patched only fields this
    // store does not own (runId, ticket, app) asked for no change to the row.
    if (Object.keys(data).length === 0) return;
    await this.runs.update({ where: { id: row.id }, data });
  }

  /**
   * The newest non-terminal run for a ticket.
   *
   * "Newest" matters as much as "non-terminal": a ticket that was re-run after
   * a kill switch has several rows, and the partial unique index from migration
   * 0002 only guarantees one of them is LIVE. Ordering by `startedAt` descending
   * means a race that briefly leaves two live rows resolves to the current one
   * rather than the abandoned one.
   */
  private liveRun(ticket: string): Promise<RunRow | null> {
    return this.runs.findFirst({
      where: { ticketKey: ticket, status: { notIn: [...TERMINAL_STATUSES] } },
      orderBy: { startedAt: "desc" },
      include: { application: true },
    });
  }
}

/**
 * The column's string as the contract's union.
 *
 * `get` only ever returns rows the `notIn` filter let through, so every value
 * reaching here is a LIVE one — but "live" is no longer a single state.
 * `openGate` writes `gate` while a human is being waited on and `handOver`'s
 * callers write `handover`, and both are non-terminal, so both come back out
 * of `get`. Flattening them to `running` (which this did) would make the
 * workflow's own read contradict what it had just written: `runs.get` would
 * report `running` for a run parked at a gate, and any future code branching
 * on that would be silently wrong.
 *
 * Anything genuinely unexpected still becomes `running` — the row IS live by
 * the only definition the store uses, and inventing a state for a value this
 * package does not know would be worse than the honest floor.
 */
function toLifecycle(status: string): RunContext["status"] {
  switch (status) {
    case "done":
    case "cancelled":
    case "gate":
    case "handover":
      return status;
    default:
      return "running";
  }
}

/**
 * Both start-of-run pins, checked as the gateway will check them.
 *
 * `trim()` before the emptiness test because the gateway's schema is
 * `z.string().min(1)` on a value that reaches it verbatim: `" "` passes a bare
 * length check here, then fails there — which is the whole failure mode this
 * guard exists to stop, one space further along.
 */
function assertPinned(input: NewRun): void {
  if (input.variantId.trim() === "") throw new UnpinnedRunError(input.ticket, "variantId");
  if (input.templateVersion.trim() === "") {
    throw new UnpinnedRunError(input.ticket, "templateVersion");
  }
}

/** `Partial<RunContext>` -> the column subset, dropping absent keys. */
export function toRunUpdate(changes: Partial<RunContext>): RunUpdate {
  const data: RunUpdate = {};
  if (changes.step !== undefined) data.step = changes.step;
  if (changes.status !== undefined) data.status = changes.status;
  if (changes.risk !== undefined && changes.risk !== null) data.risk = changes.risk;
  if (changes.locale !== undefined) data.locale = changes.locale;
  // The pins are write-once-at-open in practice, but `patch` can reach the same
  // two columns — so the same emptiness rule applies here. Dropping an empty
  // pin rather than throwing is the right shape for a PARTIAL update: the
  // caller is asking to change other fields, and un-pinning a live run is not
  // a thing any caller means to do. Keeping the pinned value is the safe half
  // of the invariant `create` enforces at the other end.
  if (changes.variantId !== undefined && changes.variantId.trim() !== "") {
    data.variantId = changes.variantId;
  }
  // Same rule for the engineer pin, for the same reason. It is the only pin
  // whose EMPTY value is meaningful ("no separate engineer agent"), but that
  // meaning belongs to a run being OPENED — a partial update that carries an
  // empty one is a caller changing other fields, not a caller un-pinning a
  // live run's engineer mid-flight.
  if (changes.engineerVariantId !== undefined && changes.engineerVariantId.trim() !== "") {
    data.engineerVariantId = changes.engineerVariantId;
  }
  if (changes.templateVersion !== undefined && changes.templateVersion.trim() !== "") {
    data.templateVersion = changes.templateVersion;
  }
  if (changes.workspacePath !== undefined) data.workspacePath = changes.workspacePath;
  if (changes.workspacePresent !== undefined) data.workspacePresent = changes.workspacePresent;
  if (changes.protectedPaths !== undefined) data.protectedPathsJson = [...changes.protectedPaths];
  if (changes.verification !== undefined) {
    data.verificationJson = changes.verification.map((spec) => ({
      name: spec.name,
      command: [...spec.command],
    }));
  }
  if (changes.branch !== undefined) data.branch = changes.branch;
  if (changes.targetBranch !== undefined) data.targetBranch = changes.targetBranch;
  // Both are nullable in the contract, so `null` is a value to write, not an
  // absence to skip. `"prId" in changes` is what distinguishes the two.
  if ("prId" in changes) data.prId = changes.prId ?? null;
  if ("resumeToken" in changes) data.resumeToken = changes.resumeToken ?? null;
  return data;
}

function toRunContext(row: RunRow, app: ApplicationRow | null): RunContext {
  return {
    runId: row.id,
    ticket: row.ticketKey,
    step: row.step,
    status: toLifecycle(row.status),
    // `null` only for an analysis-only row — `get` already refused the other
    // way a null join can happen (an appId pointing at a vanished application).
    app: app === null ? null : toApplication(app),
    dataClass: row.dataClass as RunContext["dataClass"],
    mode: row.mode as RunContext["mode"],
    locale: row.locale as RunContext["locale"],
    variantId: row.variantId,
    engineerVariantId: row.engineerVariantId,
    templateVersion: row.templateVersion,
    workspacePath: row.workspacePath,
    workspacePresent: row.workspacePresent,
    protectedPaths: parseStrings(row.protectedPathsJson),
    verification: parseCommands(row.verificationJson),
    branch: row.branch,
    targetBranch: row.targetBranch,
    risk: (row.risk as RunContext["risk"]) ?? null,
    prId: row.prId,
    resumeToken: row.resumeToken,
    // `get` bunu ÜZERİNE yazar (emekli defterleri okuduktan sonra). Buradaki
    // `null` "geçmiş yok" demek ve satırdan okunabilecek bir şey değil —
    // geçmiş EMEKLİ satırlarda duruyor, bu satırda değil.
    priorWork: null,
  };
}

function toApplication(row: ApplicationRow): ApplicationRecord {
  return {
    appId: row.appId,
    displayName: row.displayName,
    adoProject: row.adoProject,
    adoRepo: row.adoRepo,
    platform: row.platform as ApplicationRecord["platform"],
    jiraComponent: row.jiraComponent,
    maestroYamlPresent: row.maestroYamlPresent,
    createdVia: row.createdVia as ApplicationRecord["createdVia"],
  };
}

/**
 * A JSON column holds whatever was written. Anything that is not an array of
 * strings reads as "none" — for `protectedPaths` that is the SAFE direction
 * only because the M52 deny-list these add to lives in `@maestro/workflows`
 * and applies regardless; this column carries the repo's additions, and a
 * malformed value must not be able to remove a path from the base list.
 */
function parseStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * `CommandSpec[]` from a JSON column, structurally validated.
 *
 * A half-parsed command is worse than none: `{ name: "test" }` with no argv
 * would reach the runner as a spawn of `undefined`. Entries that are not a
 * name plus a non-empty string argv are dropped, so what comes back is always
 * runnable.
 */
function parseCommands(value: unknown): CommandSpec[] {
  if (!Array.isArray(value)) return [];
  const specs: CommandSpec[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, command } = entry as { name?: unknown; command?: unknown };
    if (typeof name !== "string" || name.length === 0) continue;
    if (!Array.isArray(command) || command.length === 0) continue;
    if (!command.every((part): part is string => typeof part === "string")) continue;
    specs.push({ name, command });
  }
  return specs;
}
