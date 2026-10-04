import type {
  AppId,
  ApplicationRecord,
  AuditEvent,
  DataClass,
  EvidencePackage,
  JournalEntry,
  LlmCallLog,
  PlatformProfile,
  RepoCard,
  RiskTier,
  ScanFinding,
  StepId,
  SubscriptionAccount,
  TicketKey,
  WorkMode,
  WorkflowRunStatus,
} from "@maestro/contracts";

/**
 * The read side of the single data door (M7). Studio renders 37 screens, and
 * every field on them has to come from somewhere real — so each resource below
 * is an interface the composition root fills, never a literal a route invents.
 *
 * These live in the BFF because they are the BFF's shape of the world, not the
 * platform's: `packages/contracts` and `packages/ports` are frozen, and a read
 * model that exists to serve one UI has no business in either. Everything here
 * is expressed in frozen contract types wherever a contract type exists — the
 * BFF adds the joins Studio needs, not new vocabulary for facts that already
 * have names.
 *
 * Every list method takes a bounded page and returns a cursor. An unbounded
 * list endpoint is a denial-of-service handle in a system whose journal grows
 * without limit (M30), and "the UI only asked for 50" is not a bound.
 */

/** One page of a list, with the cursor that continues it. `null` = no more. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface PageRequest {
  readonly limit: number;
  readonly cursor: string | null;
}

// ── runs (M99/M100: the ticket's platform-side facts) ─────────────────────────

/**
 * What the workflow engine does NOT know about a run. `WorkflowRunState` (the
 * frozen contract) carries step/status/risk; the application it was matched to,
 * who reported it and what it has cost are platform records, and Studio's
 * ticket list shows them side by side.
 */
export interface RunRecord {
  readonly ticketKey: TicketKey;
  /**
   * `WorkflowRun.id` — the run id the journal, the step events and the
   * evidence package are all keyed by.
   *
   * It travels on the record because the alternative was asking the ENGINE for
   * it, and the engine forgets. `runIdOf` used to resolve it with
   * `queryRunState`, so a run whose Temporal execution had aged out of
   * retention answered 404 `no_run` for its journal, its summary, its evidence
   * and its cost — four "veri alınamadı" panels over a database that still
   * held every row. Measured on the live board: thirteen of fourteen `running`
   * runs had no execution left, and one of them had thirteen journal entries
   * sitting in Postgres that Studio could not reach.
   *
   * The catalog row is the right source: `JournalEntry.runId` is a FOREIGN KEY
   * to this column, so a record read from the catalog can always name the rows
   * that point at it — with no second system to outlive.
   */
  readonly runId: string;
  readonly title: string;
  readonly appId: AppId | null;
  readonly mode: WorkMode;
  readonly risk: RiskTier;
  readonly dataClass: DataClass;
  /**
   * How far the run got — the ticket list's "Adım" column.
   *
   * The workflow writes it on every transition and the list rendered "—" for
   * every row anyway, because this field did not exist: the read model had the
   * column in the database and dropped it on the way out.
   */
  readonly step: string;
  /**
   * The PLATFORM's verdict on the run — `WorkflowRun.status`, the column the
   * reconciler writes when it compares the catalog against the engine.
   *
   * It is here because the engine's answer is not the whole truth. A workflow
   * whose activity exhausted its retries dies INSIDE that activity and cannot
   * write its own epitaph, so Temporal keeps answering `queryRunState` with the
   * last step it remembers — `running`, forever. Eleven dead runs read as live
   * work on the operator's board because the list had no second opinion to
   * consult. `WorkflowRunStatus` (frozen contract) is that second opinion, and
   * it is the SAME vocabulary the engine speaks so the route can compare them
   * without translating.
   *
   * `null` when the store cannot say — a catalog that has no status column to
   * read from must not invent one, and the route already knows how to render a
   * row whose status nobody can supply.
   */
  readonly status: WorkflowRunStatus | null;
  /** Parent ticket for a fan-out child (M100); `null` for a standalone run. */
  readonly parentTicketKey: TicketKey | null;
  readonly childTicketKeys: readonly TicketKey[];
  readonly reporter: string;
  readonly assignee: string | null;
  readonly prId: number | null;
  readonly costUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  /**
   * When an operator retired this run from the dashboard's default view
   * (`WorkflowRun.archivedAt`, 0019); `null` for a run still on the board.
   *
   * It travels on the record rather than being consumed silently by the query
   * because Studio has to be able to SAY so: a row that appears only under
   * "arşivlenmiş" must be labelled as archived, and the un-archive button has
   * to know which state it is toggling out of. A filter that dropped the flag
   * after using it would leave the screen unable to tell an archived row from
   * an active one in the very view whose purpose is showing both.
   */
  readonly archivedAt: string | null;
}

export interface RunCatalogFilter extends PageRequest {
  readonly appId: string | null;
  readonly projectKeys: readonly string[] | null;
  /**
   * Which side of the archive line to list (0019).
   *
   * Three values, not a boolean, because "archived" has three useful answers
   * and only two of them are expressible as one:
   *   `"active"`   — `archivedAt IS NULL`. The DEFAULT, and the whole point:
   *                  yesterday's dealt-with failures stop greeting a new
   *                  operator as if the product were broken.
   *   `"archived"` — `archivedAt IS NOT NULL`. The explicit way back in, so
   *                  archiving hides a run without hiding it from anyone.
   *   `"all"`      — no clause. What an auditor asks for.
   *
   * It is a STORE-LEVEL filter rather than something the route drops after the
   * fact, for the same reason `projectKeys` is (see PrismaRunCatalog): a page
   * of `limit` rows must be a page of rows the caller asked to see, or paging
   * silently shortens and the caller cannot tell a short page from a last one.
   */
  readonly archived: ArchiveScope;
}

/** @see RunCatalogFilter.archived */
export type ArchiveScope = "active" | "archived" | "all";

/**
 * Per-run platform metadata.
 *
 * Almost reads-only: a run's FACTS change because the workflow advanced, never
 * because Studio asked for them. `setArchived` is the one exception and it
 * deliberately writes no fact — it records that an operator retired the row
 * from a view, which is a statement about the dashboard, not about the run.
 */
export interface RunCatalog {
  get(ticketKey: string): Promise<RunRecord | null>;
  list(filter: RunCatalogFilter): Promise<Page<RunRecord>>;
  /**
   * Archive (`at`) or un-archive (`null`) a run, by ticket key.
   *
   * Returns `false` when no such run exists, so the route can answer 404
   * rather than reporting success for a ticket nobody has. The clock is passed
   * IN rather than read here: the BFF owns one clock (`deps.clock`) so a test
   * can pin the recorded moment and the audit entry beside it agrees.
   */
  setArchived(ticketKey: string, at: Date | null): Promise<boolean>;
  /**
   * ÖLÜ BİR KOŞUYU EMEKLİYE AYIR — yerine yenisi başlatılabilsin diye.
   *
   * ── Neden bu var ──────────────────────────────────────────────────────────
   * Bir koşunun satır kimliği (`WorkflowRun.id`) motorun iş akışı kimliğiyle
   * AYNI: `maestro-<ticket>`. Yani bir ticket'ın ikinci koşusu, birincinin
   * birincil anahtarına çarpar — `create` bunu bir yarış sanıp yutar ve ortada
   * yeni koşu YOKMUŞ gibi eski satır durmaya devam eder. Ölü bir koşusu olan
   * ticket, bu yüzden bir daha hiç akışa alınamıyordu.
   *
   * ── Neden SİLME değil ─────────────────────────────────────────────────────
   * Silinemez zaten: defter (`JournalEntry`), adım olayları, kanıt paketi ve
   * kapı kayıtlarının hepsi bu satıra `onDelete: Restrict` ile bağlı. Ama asıl
   * sebep o değil — eski koşunun defteri KORUNMALI, çünkü M33 zinciri o koşuda
   * ne olduğunu anlatıyor ve bir denetçinin sorusu tam olarak orada cevabını
   * buluyor. Yapılan şey satırı TERMİNAL statüye çekip arşivlemek: defter,
   * adımlar, kanıt ve kapılar yazıldıkları kimlikte olduğu gibi kalır — tek bir
   * satır bile yeniden yazılmaz, ve ticket yine de yoldan çekilir, çünkü
   * `WorkflowRun_ticketKey_live_key` yalnız terminal OLMAYAN satırları
   * kısıtlıyor. Kimliği değiştirmek denenmişti ve defterin yalnızca-ekleme
   * korumasına çarpıyordu (bkz. `PrismaRunCatalog.retire`).
   *
   * ── Neden yalnız ÖLÜ koşular ──────────────────────────────────────────────
   * Yaşayan bir koşuyu emekliye ayırmak, kapıda insan onayı bekleyen işi
   * sessizce yok saymak olurdu. Çağıran taraf koşunun gerçekten bittiğini
   * (motorda karşılığı yok ya da satır terminal) ölçmeden burayı çağırmamalı;
   * bu port o ölçümü tekrarlamaz, yalnız yazar.
   *
   * `null` = böyle bir ticket yok (rota 404'e çevirir). Başarıda emekliye
   * ayrılan satırın YENİ kimliği döner, ki denetim kaydı hangi satırın
   * taşındığını adıyla yazabilsin.
   */
  retire(ticketKey: string, at: Date): Promise<RetiredRun | null>;
}

/**
 * Bir emekliye ayırmanın sonucu — YENİ kimlik ve ticket'ın KAÇINCI emekliliği.
 *
 * ── Neden sayı da dönüyor ─────────────────────────────────────────────────
 * Tarama artık ölü koşuları KENDİLİĞİNDEN yeniden başlatıyor
 * (`run-restart.ts`). Kalıcı bir hata yüzünden her koşusu ölen bir ticket, o
 * yol frensiz olsaydı her turda yeniden başlatılırdı: sonsuz bir döngü, ve
 * her turunda bir denetim kaydı, bir Jira yorumu, bir LLM çağrısı. Freni
 * kurmak için "bu ticket kaç kez yeniden başlatıldı" sorusunun bir cevabı
 * olması gerekiyor.
 *
 * ── Neden yeni bir SÜTUN değil ────────────────────────────────────────────
 * Cevap zaten veritabanında duruyor: her emeklilik ARŞİV DAMGASI basılmış bir
 * satır bırakıyor (`archivedAt not null`), ve o satırlar silinmiyor (defter,
 * adım, kanıt ve kapı kayıtları onlara bağlı). Sayaç için bir sütun açmak, aynı
 * olguyu ikinci kez — ve ilkiyle çelişebilecek şekilde — saymak olurdu.
 * Sayının kaynağı emekli satırların KENDİSİ; bir göç gerekmiyor.
 *
 * `count` bu emeklilik DAHİL: ilk kez emekliye ayrılan bir ticket 1 döner.
 */
export interface RetiredRun {
  /**
   * Emekliye ayrılan satırın kimliği — denetim kaydı bunu adıyla yazar.
   *
   * DEĞİŞMİYOR: emekliye ayırma satırın adına dokunmuyor, çünkü dokunmak
   * `JournalEntry.runId`'yi cascade ile UPDATE ettiriyor ve o tablo
   * yalnızca-ekleme korumalı (M30/M33). Yani bu kimlik, eski koşunun defterinin
   * GERÇEKTEN durduğu kimlik — denetçinin peşine düşeceği ad.
   */
  readonly id: string;
  /** Ticket'ın bugüne kadarki emeklilik sayısı, bu emeklilik dahil. */
  readonly count: number;
}

// ── journal (M30) ─────────────────────────────────────────────────────────────

export interface JournalFilter extends PageRequest {
  /** Studio's actor chips; `null` shows everything. */
  readonly actor: JournalEntry["actor"] | null;
}

export interface JournalReader {
  list(runId: string, filter: JournalFilter): Promise<Page<JournalEntry>>;
  /** The living summary text (M30), or `null` when the run has produced none. */
  summary(runId: string): Promise<string | null>;
}

// ── gates (M71/M101) ──────────────────────────────────────────────────────────

/**
 * A gate waiting on a human. Deliberately a READ model: `canCloseGate` lives in
 * `packages/workflows` and a decision reaches it as a signal, so there is no
 * shape here that could be mistaken for a way to close one.
 */
export interface OpenGate {
  readonly ticketKey: TicketKey;
  readonly runId: string;
  readonly step: StepId;
  readonly ownerGroup: string;
  readonly openedAt: string;
  /** Who the reminder ladder has escalated to, if it has (M45). */
  readonly delegatedTo: string | null;
}

export interface GateFilter extends PageRequest {
  readonly ownerGroup: string | null;
  readonly projectKeys: readonly string[] | null;
}

export interface GateBoard {
  listOpen(filter: GateFilter): Promise<Page<OpenGate>>;
}

// ── application registry + repo cards (M100) ──────────────────────────────────

export interface AppRegistry {
  get(appId: string): Promise<ApplicationRecord | null>;
  list(page: PageRequest): Promise<Page<ApplicationRecord>>;
  /** The analyst's cross-app impact source (M100); `null` when never generated. */
  repoCard(appId: string): Promise<RepoCard | null>;
}

// ── knowledge (M18/M63) ───────────────────────────────────────────────────────

/**
 * A knowledge document. `dataClass` is REQUIRED and never defaulted: an index
 * that cannot classify a document must report `gizli`, because an unlabelled
 * confidential file read as `dahili` is exactly how one leaves the building.
 */
export interface KnowledgeDoc {
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  readonly source: string;
  readonly score: number;
  readonly dataClass: DataClass;
  readonly appId: AppId | null;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface KnowledgeQuery extends PageRequest {
  readonly text: string;
  readonly appId: string | null;
}

export interface KnowledgeIndex {
  search(query: KnowledgeQuery): Promise<Page<KnowledgeDoc>>;
}

// ── runners + sandboxes (M60/M31) ─────────────────────────────────────────────

export interface RunnerRecord {
  readonly runnerId: string;
  readonly pool: string;
  readonly platform: PlatformProfile;
  readonly state: "idle" | "busy" | "draining" | "unreachable";
  readonly capacity: number;
  readonly activeSandboxes: number;
  readonly lastHeartbeatAt: string;
  /** Why a runner is not fully healthy; `null` when it is. */
  readonly note: string | null;
}

export interface SandboxRecord {
  readonly ticketKey: TicketKey;
  readonly runnerId: string;
  readonly state: "active" | "resumable" | "human_held";
  readonly sizeBytes: number;
  readonly lastAccessAt: string;
}

export interface RunnerFleet {
  list(page: PageRequest): Promise<Page<RunnerRecord>>;
  sandboxes(page: PageRequest): Promise<Page<SandboxRecord>>;
}

// ── quota + cost (M55/M16) ────────────────────────────────────────────────────

export interface QuotaReader {
  /** The subscription account pool and its windows (M55). */
  accounts(): Promise<readonly SubscriptionAccount[]>;
}

export interface CostFilter extends PageRequest {
  readonly runId: string | null;
}

export interface CostReader {
  /** Gateway call log rows (M16); the per-run and per-model breakdowns derive from these. */
  calls(filter: CostFilter): Promise<Page<LlmCallLog>>;
}

// ── security scans (M27) ──────────────────────────────────────────────────────

export interface ScanRecord {
  readonly ticketKey: TicketKey;
  readonly finding: ScanFinding;
  readonly outcome: "pass" | "fail" | "error";
  readonly at: string;
}

export interface ScanFilter extends PageRequest {
  readonly projectKeys: readonly string[] | null;
}

export interface ScanReader {
  list(filter: ScanFilter): Promise<Page<ScanRecord>>;
}

// ── evidence (M56) ────────────────────────────────────────────────────────────

export interface EvidenceReader {
  /** The manifest for a closed run (M56); `null` before the package is built. */
  get(runId: string): Promise<EvidencePackage | null>;
}

// ── audit (M33) ───────────────────────────────────────────────────────────────

export interface AuditFilter extends PageRequest {
  readonly actor: string | null;
  readonly subject: string | null;
  /** ISO lower bound on `at`, inclusive (B13 regulator window). */
  readonly from: string | null;
  /** ISO upper bound on `at`, inclusive. */
  readonly to: string | null;
  /** Exact action match. */
  readonly action: string | null;
  /** Case-insensitive substring over subject + actor + action. */
  readonly q: string | null;
}

/**
 * The trail as Studio reads it. `AuditChain` already owns appending and
 * verification; this is the query side, which the chain deliberately does not
 * expose — a reader that could reach `append` would be a second writer.
 */
export interface AuditReader {
  list(filter: AuditFilter): Promise<Page<AuditEvent>>;
  /** Recompute the hash chain (M33). Read-only: it proves, it never repairs. */
  verify(): Promise<{ ok: boolean; checked: number; brokenAtSeq: number | null }>;
}

// ── platform services health (M6) ─────────────────────────────────────────────

export interface ServiceHealth {
  readonly service: string;
  /**
   * `not_configured` is the honest third answer for a dependency the platform
   * would USE if it existed — an LLM or Jira connection nobody has created
   * yet. It is deliberately not `down`: "nobody set this up" and "this is
   * broken" send an operator to entirely different places, and the aggregate
   * state must not page anyone over a connector that was never configured.
   */
  readonly state: "healthy" | "degraded" | "down" | "not_configured";
  readonly version: string;
  readonly checkedAt: string;
  readonly note: string | null;
}

export interface HealthReader {
  services(): Promise<readonly ServiceHealth[]>;
}
