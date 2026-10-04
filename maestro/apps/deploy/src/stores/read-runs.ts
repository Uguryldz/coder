import type {
  AppId,
  DataClass,
  MatchResult,
  RiskTier,
  TicketKey,
  WorkMode,
  WorkflowRunStatus,
} from "@maestro/contracts";
import {
  encodeCursor,
  decodeCursor,
  type ArchiveScope,
  type Page,
  type RunCatalog,
  type RunCatalogFilter,
  type RetiredRun,
  type RunRecord,
} from "@maestro/bff";

/**
 * The Postgres-backed `RunCatalog` (M99/M100) — Studio's ticket list.
 *
 * Two things make this more than a `findMany`:
 *
 *  1. **The project scope is part of the QUERY, not a filter applied after.**
 *     `projectKeys` comes from the caller's directory groups (M86), and the
 *     BFF's contract is that a page of `limit` rows is a page of rows the
 *     caller may actually see. Fetching a page and then dropping the rows they
 *     may not see would silently shorten every page — and, worse, would let a
 *     caller measure another project's volume by how short their page came
 *     back. The scope is therefore a `WHERE` clause, applied before `LIMIT`.
 *
 *  2. **The fan-out family is derived from `matchJson`, not stored twice.**
 *     `RunRecord` carries `parentTicketKey` and `childTicketKeys`, and there is
 *     no parent/child column: the relationship IS the `analysis_fanout`
 *     `MatchResult` a child was created with (M100). Reading it back from the
 *     match is what keeps the two from disagreeing — a denormalised copy would
 *     eventually name a parent the match does not.
 */

/** The `WorkflowRun` columns this read model touches, and no more. */
export interface RunCatalogRow {
  id: string;
  ticketKey: string;
  appId: string | null;
  mode: WorkMode;
  risk: RiskTier | null;
  dataClass: DataClass;
  /**
   * `WorkflowRun.status` — the Prisma enum, whose members are exactly
   * `WorkflowRunStatus`'s. Selected because Studio's list needs the platform's
   * verdict alongside the engine's: the reconciler writes `fail` here for a run
   * that died inside an activity, and the engine goes on reporting that run as
   * `running` because a crashed workflow cannot correct its own history.
   */
  status: WorkflowRunStatus;
  /**
   * How far the run got. The panel's ticket list has a "Adım" column and had
   * nothing to put in it: the workflow writes this column on every transition
   * (`journal` → `runs.patch`), and the read model never selected it, so every
   * row rendered "—" no matter where the run actually was.
   */
  step: string;
  prId: number | null;
  matchJson: unknown;
  startedAt: Date;
  updatedAt: Date;
  /**
   * `WorkflowRun.archivedAt` (0019) — when an operator retired this run from
   * the dashboard's default view, or `null` while it is still on the board.
   *
   * Selected rather than merely filtered on, because the "arşivlenmiş" view
   * has to render the flag it selected by: a row shown there without it would
   * be indistinguishable from an active one, and the un-archive control would
   * have nothing to read its current state from.
   */
  archivedAt: Date | null;
}

/** The `WHERE` this store builds; `ticketKey.startsWith` is the project scope. */
export interface RunCatalogWhere {
  appId?: string;
  OR?: { ticketKey: { startsWith: string } }[];
  ticketKey?: string;
  /**
   * The archive scope as Prisma spells it (0019): `{ archivedAt: null }` for
   * the active board, `{ archivedAt: { not: null } }` for the archived view,
   * and the key ABSENT for "all" — an absent clause is the only honest way to
   * say "no restriction", since every value of `archivedAt` would otherwise
   * have to be enumerated.
   */
  archivedAt?: null | { not: null };
}

export interface RunCatalogDelegate {
  findMany(args: {
    where: RunCatalogWhere;
    orderBy: { updatedAt: "desc" };
    skip?: number;
    take?: number;
  }): Promise<RunCatalogRow[]>;
  count(args: { where: RunCatalogWhere }): Promise<number>;
  /**
   * The one write on this delegate. `updateMany`, not `update`, on purpose:
   * `ticketKey` is deliberately NOT unique (a ticket may legitimately be
   * re-run — see the schema's note on `@@index([ticketKey])`), so `update`
   * would need a primary key this surface does not have, and picking one row
   * of several by hand would archive an arbitrary member of the ticket's
   * history. `updateMany` on the key retires the ticket's runs together, which
   * is what an operator clicking "Arşivle" on a ticket row means, and its
   * `count` is what tells a missing ticket apart from an archived one.
   */
  updateMany(args: {
    where: RunCatalogWhere;
    data: { archivedAt: Date | null };
  }): Promise<{ count: number }>;
  /**
   * `retire`in yazma ucu — TEK bir satırın KİMLİĞİNE DOKUNMADAN emekliye
   * ayrılması.
   *
   * ── Neden kimlik DEĞİŞMİYOR (eskiden değişiyordu, ve saha onu kırdı) ──────
   * Bu imza `data: { id, archivedAt }` idi: emekliye ayırma satırın birincil
   * anahtarını `maestro-<ticket>#emekli-<damga>` yapıyor, kardeş tablolar da
   * `onUpdate: Cascade` ile peşinden taşınıyordu. Postgres'te o cascade
   * `UPDATE "JournalEntry" SET "runId" = …` demek, ve `JournalEntry` M30/M33
   * tetikleyicisiyle YALNIZCA-EKLEME: veritabanı UPDATE'i reddediyor
   * (`maestro_append_only`, P0001). Yani defteri korumak için konan kural
   * defteri TAŞIMAYI engelliyordu, ve emekliye ayırmanın TEK yazısı olduğu
   * için hem elle "Yeniden başlat" düğmesi (500) hem otomatik tarama turu
   * kırılıyordu — ölü koşusu olan ticket kalıcı olarak akış dışı kalıyordu.
   *
   * Kimlik değiştirmek amacın kendisi değil, seçilmiş bir yoldu: amaç eski
   * satırı YOLDAN ÇEKMEK, ki ticket yeniden akışa alınabilsin. Bunu kimlik
   * değil STATÜ yapıyor — `WorkflowRun_ticketKey_live_key` (0002/0011) yalnız
   * `status NOT IN ('done','cancelled','fail')` satırlarını kısıtlar, yani
   * eski satır terminal bir statüye geçtiği anda yeni koşu aynı ticket için
   * kendi satırını açabilir. Kimlik ise `maestro-<ticket>` kalır ve defterin
   * yabancı anahtarı HİÇ yazılmaz: append-only garantisine dokunulmaz.
   *
   * `archivedAt` aynı yazıda veriliyor: emekliye ayrılan satır panonun
   * varsayılan görünümünden de çıkmalı, yoksa operatör aynı ticket'ı iki kez
   * (biri ölü, biri yeni) görür ve hangisinin canlı olduğunu ayırt edemez.
   *
   * `status` da aynı yazıda, çünkü ikisi tek bir olgunun iki yüzü ve ayrı
   * yazılsalardı aradaki pencerede satır "arşivlenmiş ama hâlâ canlı" olurdu —
   * tam da yeni koşunun kısmi unique indekse çarpacağı hâl.
   */
  update(args: {
    where: { id: string };
    data: { archivedAt: Date; status: "fail" };
  }): Promise<unknown>;
  findFirst(args: {
    where: { ticketKey: string };
    orderBy: { updatedAt: "desc" };
  }): Promise<{ id: string } | null>;
}

/**
 * Per-run consumption, summed from the gateway call log (M16).
 *
 * `RunRecord.costUsd`/`tokensIn`/`tokensOut` are totals, and they are computed
 * from `LlmCall` rather than kept on the run row for the same reason the
 * fan-out family is: the call log is where a call is actually recorded, so a
 * total derived from it cannot drift from the calls it claims to sum.
 */
export interface RunCostDelegate {
  groupBy(args: {
    by: ["runId"];
    where: { runId: { in: string[] } };
    _sum: { tokensIn: true; tokensOut: true; usd: true };
  }): Promise<RunCostGroup[]>;
}

export interface RunCostGroup {
  runId: string | null;
  _sum: {
    tokensIn: number | null;
    tokensOut: number | null;
    usd: { toNumber(): number } | null;
  };
}

/** Totals for one run; absent from the map when the run made no calls. */
interface RunTotals {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

/**
 * The scope as a `WHERE` fragment.
 *
 * `null` means "every project" (a cross-project role, M86) and produces no
 * clause at all. An EMPTY list is the opposite and must not be confused with
 * it: an account in no project group sees nothing, so the clause has to match
 * nothing rather than be omitted. `OR: []` is Prisma's "no row matches", which
 * is precisely the fail-closed reading.
 */
export function scopeWhere(projectKeys: readonly string[] | null): RunCatalogWhere {
  if (projectKeys === null) return {};
  return { OR: projectKeys.map((key) => ({ ticketKey: { startsWith: `${key}-` } })) };
}

/**
 * The archive scope as a `WHERE` fragment (0019).
 *
 * `"all"` produces NO clause, which is the difference between "every run" and
 * "every run I thought to enumerate" — the same distinction `scopeWhere` draws
 * between a null scope and an empty one. The default is decided by the caller,
 * not here: this function has no opinion, so a route that forgets to pass a
 * scope fails to compile rather than quietly listing archived rows again.
 */
export function archiveWhere(scope: ArchiveScope): RunCatalogWhere {
  if (scope === "all") return {};
  return { archivedAt: scope === "active" ? null : { not: null } };
}

/**
 * The parent a fan-out child was created under, from its `MatchResult`.
 *
 * Anything that is not an `analysis_fanout` match has no parent — including a
 * malformed `matchJson`, which is read as "no parent" rather than trusted for
 * a ticket key. The value is JSON from a column, so it is checked structurally
 * before a field is read off it.
 */
export function parentOf(matchJson: unknown): TicketKey | null {
  if (typeof matchJson !== "object" || matchJson === null) return null;
  const match = matchJson as Partial<MatchResult> & { parentTicketKey?: unknown };
  if (match.via !== "analysis_fanout") return null;
  return typeof match.parentTicketKey === "string" ? match.parentTicketKey : null;
}

export class PrismaRunCatalog implements RunCatalog {
  constructor(
    private readonly runs: RunCatalogDelegate,
    private readonly calls: RunCostDelegate,
  ) {}

  /**
   * One run by ticket key.
   *
   * Unscoped on purpose: the route that calls this checks `assertProjectAccess`
   * BEFORE the lookup, so a caller never reaches here for a ticket they may not
   * see. Adding a second scope check here would need a `projectKeys` argument
   * the interface does not have, and inventing one would be a different answer
   * to "may I see this" than the route's — the copy that disagrees in the
   * caller's favour being the one nobody notices.
   */
  async get(ticketKey: string): Promise<RunRecord | null> {
    const [row] = await this.runs.findMany({
      where: { ticketKey },
      orderBy: { updatedAt: "desc" },
      take: 1,
    });
    if (row === undefined) return null;
    const [record] = await this.decorate([row]);
    return record ?? null;
  }

  /**
   * One page of the ticket list, newest activity first.
   *
   * The offset comes from the cursor and the count from the same `WHERE`, so
   * `nextCursor` is `null` exactly when the page reached the end of the
   * filtered set — the same rule `paginate` applies in memory, expressed in
   * SQL because the rows must not all be loaded to slice one page out.
   */
  async list(filter: RunCatalogFilter): Promise<Page<RunRecord>> {
    const where: RunCatalogWhere = {
      ...scopeWhere(filter.projectKeys),
      ...(filter.appId === null ? {} : { appId: filter.appId }),
      ...archiveWhere(filter.archived),
    };
    // The same fingerprint the in-memory catalog uses, so a cursor means the
    // same thing whichever implementation issued it.
    //
    // The archive scope is PART of the fingerprint: a cursor is an offset into
    // one filtered set, and the active board and the archived view are two
    // different sets. Without it, paging the board and then switching to the
    // archive would resume at the board's offset and skip that many archived
    // rows — silently, which is the failure mode this codebase treats as worse
    // than a crash.
    const fingerprint = `runs:${filter.appId ?? ""}:${filter.archived}`;
    const offset = decodeCursor(filter.cursor, fingerprint);

    const rows = await this.runs.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: offset,
      take: filter.limit,
    });
    const total = await this.runs.count({ where });
    const next = offset + rows.length;

    return {
      items: await this.decorate(rows),
      nextCursor: next < total ? encodeCursor(next, fingerprint) : null,
    };
  }

  /**
   * Archive or un-archive a ticket's runs (0019).
   *
   * The ONLY write on this store, and it deliberately touches one column. It
   * is not a delete and must not become one: the row, its journal, its step
   * events and its evidence package all stay exactly where they are, and the
   * M33 chain records that an operator did this. What changes is which view
   * the row appears in by default.
   *
   * Unscoped by project for the same reason `get` is: the route checks
   * `assertProjectAccess` before calling, and a second opinion here would be a
   * second answer to "may I touch this" — the one that disagreed in the
   * caller's favour being the one nobody notices.
   *
   * `count === 0` means no such ticket, which the route turns into a 404. It
   * cannot mean "already in that state": `updateMany` counts rows MATCHED by
   * the where-clause, and the clause names only the ticket, so archiving an
   * already-archived run reports 1 and is an idempotent no-op — the right
   * answer for a double-click, and never a false 404 for a run that exists.
   */
  async setArchived(ticketKey: string, at: Date | null): Promise<boolean> {
    const { count } = await this.runs.updateMany({ where: { ticketKey }, data: { archivedAt: at } });
    return count > 0;
  }

  /**
   * Ölü koşuyu emekliye ayır: KİMLİĞİNE DOKUNMADAN yoldan çek, defterini
   * olduğu yerde bırak.
   *
   * ── Emekliye ayırmanın AMACI ──────────────────────────────────────────────
   * Eski koşuyu yoldan çekmek, ki ticket yeniden akışa alınabilsin, VE geçmişi
   * kaybetmemek. Bu iki şart; kimlik değiştirmek bunların hiçbiri değil.
   *
   * ── Neden kimlik ARTIK değişmiyor ─────────────────────────────────────────
   * Bu satır bir zamanlar `data: { id: retiredId, archivedAt: at }` idi ve
   * SAHADA KIRILDI. Kardeş tablolar `onUpdate: Cascade` taşıyor, dolayısıyla
   * birincil anahtarı değiştirmek Postgres'e `UPDATE "JournalEntry" SET
   * "runId" = …` yazdırıyor — ve `JournalEntry` M30/M33 tetikleyicisiyle
   * YALNIZCA-EKLEME, yani UPDATE'i veritabanı reddediyor (`maestro_append_only`,
   * P0001). Emekliye ayırmanın tek yazısı bu olduğu için hem operatörün elle
   * bastığı "Yeniden başlat" düğmesi 500 veriyor hem tarama turu her turda
   * aynı ticket'ta patlıyordu: ölü koşusu olan ticket KALICI olarak akış dışı
   * kalıyordu. Defteri korumak için konan kural, defteri taşımayı engelliyordu.
   *
   * Doğru cevap kuralı gevşetmek değil (append-only denetim zincirinin temeli,
   * ve `runId` için açılacak bir delik "hangi koşunun defteri" sorusunu
   * sonradan yazılabilir yapardı) — kimliği hiç değiştirmemek.
   *
   * ── Kimlik değişmeden ÇAKIŞMA nasıl çözülüyor ─────────────────────────────
   * Yeni koşunun satırını açan tarafın çarptığı kısıt birincil anahtar DEĞİL:
   * `PrismaRunContextStore.create` önce `liveRun` ile bakıyor
   * (`status notIn TERMINAL_STATUSES`) ve veritabanı tarafında
   * `WorkflowRun_ticketKey_live_key` (0002, 0011'de genişletildi) yalnız
   * `status NOT IN ('done','cancelled','fail')` satırlarını kısıtlıyor.
   * Yani ticket'ı yoldan çeken şey STATÜ. Eski satır `fail`e geçtiği anda
   * ticket'ın canlı satırı kalmıyor ve yeni koşu `maestro-<ticket>` kimliğini
   * yeniden kullanabiliyor — birincil anahtar zaten ticket başına tek satır
   * tutmuyordu, ÇÜNKÜ o kimliği taşıyan satır artık canlı değil.
   *
   * ── Kimlik ÇAKIŞMASI nerede çözülüyor: YAZAN tarafta ─────────────────────
   * Emekli satır `maestro-<ticket>` kimliğini KORUDUĞU için yeni koşu o
   * kimliği bir daha kullanamaz — birincil anahtar hâlâ dolu. Eskiden bunu
   * emekli satırın adını değiştirerek "boşaltma" yolu seçilmişti; append-only
   * duvarına çarpan da tam olarak oydu.
   *
   * Doğru yer okuyan taraf değil, YAZAN taraf: yeni satırı açan
   * `PrismaRunContextStore.create` artık ticket'ın kullanılmamış bir kimliğini
   * seçiyor (`maestro-<ticket>`, sonra `maestro-<ticket>-2`, `-3`, …). Böylece
   * hiçbir satırın adı DEĞİŞMİYOR: emekli satır kendi adıyla, defteriyle,
   * kanıtıyla olduğu gibi duruyor; yeni koşu kendi adını alıyor. Bkz.
   * `PrismaRunContextStore.create` (`run-context.ts`).
   *
   * ── Neden `fail` ──────────────────────────────────────────────────────────
   * Terminal küme `('done','cancelled','fail')` ve emekliye ayrılan koşu
   * bunlardan yalnız birine dürüstçe uyuyor: `done` başarıyla bitmiş demek
   * (bitmedi), `cancelled` bir insanın iptal ettiği demek (etmedi). Koşu
   * MOTORDA ÖLDÜĞÜ için emekliye ayrılıyor, ve `fail` tam olarak bunu söyler —
   * `reconcileRunStatuses` da motorda ölmüş bir koşuya aynı statüyü yazıyor
   * (`DB_STATUS_BY_EXECUTION`), yani iki yol aynı olguya aynı adı veriyor.
   *
   * ── Ne KAYBOLMUYOR ────────────────────────────────────────────────────────
   * Hiçbir şey, ve eskisinden DAHA azına dokunularak: satır silinmiyor,
   * kopyalanmıyor, adı bile değişmiyor. Defter (`JournalEntry`), adım olayları,
   * kanıt kalemleri ve kapı kayıtları zaten `maestro-<ticket>`e bağlı ve öyle
   * kalıyor — tek bir yabancı anahtar yazısı yapılmadığı için taşınma
   * sırasında kaybolma ihtimali de ortadan kalkıyor. `priorWork` bu satırları
   * `ticketKey` + `archivedAt not null` ile buluyor (`PrismaRunContextStore`),
   * ve o sorgu kimliğe hiç bakmadığı için aynen çalışmaya devam ediyor.
   *
   * `null` = böyle bir ticket yok.
   */
  async retire(ticketKey: string, at: Date): Promise<RetiredRun | null> {
    const row = await this.runs.findFirst({ where: { ticketKey }, orderBy: { updatedAt: "desc" } });
    if (row === null) return null;
    // Kimlik AYNEN kalıyor; değişen yalnız statü ve arşiv damgası. Tek yazı,
    // çünkü ikisi tek bir olgu: "bu koşu bitti ve panodan çekildi".
    await this.runs.update({ where: { id: row.id }, data: { archivedAt: at, status: "fail" } });
    /**
     * KAÇINCI EMEKLİLİK — otomatik yeniden başlatmanın sonsuz döngü freni.
     *
     * Yazıdan SONRA sayılıyor, ki bu emeklilik de sayıya dahil olsun: çağıran
     * "bu ticket kaçıncı kez yeniden başlatılıyor" sorusunun cevabını istiyor,
     * "önce kaç kez başlatılmıştı"nın değil.
     *
     * `archivedAt: { not: null }` elle ARŞİVLENMİŞ satırları da sayar, ve bu
     * bilinçli bir fazla saymadır: emekli satır ile elle arşivlenmiş satırı
     * ayırmanın tek yolu satırın kimliğine bakmak olurdu, ve emeklilik artık
     * kimliğe HİÇ dokunmadığı için orada okunacak bir işaret de yok. Frenin
     * yönü zaten güvenli tarafa bakıyor: fazla sayan bir sayaç ROBOTU ERKEN
     * DURDURUR ve işi insana devreder, eksik sayan bir sayaç ise döngüyü açık
     * bırakırdı. Elle arşivlemek nadir ve operatörün kendi kararı; onun
     * ardından gelen bir devir, sessiz bir döngüden iyidir.
     */
    const count = await this.runs.count({ where: { ticketKey, archivedAt: { not: null } } });
    // Emekliye ayrılan satırın kimliği — DEĞİŞMEDİĞİ için okunduğu gibi.
    // Denetim zinciri bunu "önceki koşunun defteri nerede" sorusunun cevabı
    // olarak yazıyor, ve o defter gerçekten hâlâ bu kimlikte duruyor.
    return { id: row.id, count };
  }

  /**
   * Rows -> records: the two joins Studio's list needs.
   *
   * Both are batched across the whole page rather than issued per row — a
   * per-row query here is the classic N+1 that turns a 50-row page into 101
   * round trips.
   */
  private async decorate(rows: readonly RunCatalogRow[]): Promise<RunRecord[]> {
    const totals = await this.totalsFor(rows.map((row) => row.id));
    const children = this.childrenOf(rows);
    return rows.map((row) => toRunRecord(row, totals.get(row.id), children.get(row.ticketKey)));
  }

  /** Consumption per run id, from the call log. */
  private async totalsFor(runIds: readonly string[]): Promise<Map<string, RunTotals>> {
    const totals = new Map<string, RunTotals>();
    if (runIds.length === 0) return totals;

    const groups = await this.calls.groupBy({
      by: ["runId"],
      where: { runId: { in: [...runIds] } },
      _sum: { tokensIn: true, tokensOut: true, usd: true },
    });
    for (const group of groups) {
      if (group.runId === null) continue;
      totals.set(group.runId, {
        // `usd` is null for subscription drivers (M55) and sums to null when
        // every call on a run was one; that is zero spend, not unknown spend.
        costUsd: group._sum.usd?.toNumber() ?? 0,
        tokensIn: group._sum.tokensIn ?? 0,
        tokensOut: group._sum.tokensOut ?? 0,
      });
    }
    return totals;
  }

  /**
   * Children per parent ticket, for the rows ON THIS PAGE.
   *
   * Scoped to the page deliberately: a page's children are the ones the caller
   * can already see, and querying the whole table for every parent would leak
   * the existence of children in projects the caller has no access to.
   */
  private childrenOf(rows: readonly RunCatalogRow[]): Map<string, TicketKey[]> {
    const children = new Map<string, TicketKey[]>();
    for (const row of rows) {
      const parent = parentOf(row.matchJson);
      if (parent === null) continue;
      const siblings = children.get(parent) ?? [];
      siblings.push(row.ticketKey);
      children.set(parent, siblings);
    }
    return children;
  }
}

/**
 * Row -> `RunRecord`.
 *
 * `title`, `reporter` and `assignee` are Jira's facts, and `WorkflowRun` has
 * no column for any of them — see `read-degraded.ts` for why they are the
 * ticket key and `""` rather than a plausible-looking invention.
 */
export function toRunRecord(
  row: RunCatalogRow,
  totals: RunTotals | undefined,
  children: readonly TicketKey[] | undefined,
): RunRecord {
  return {
    ticketKey: row.ticketKey,
    // The row's own primary key, straight through. This is what the journal,
    // the step events and the evidence package are keyed by, and reading it
    // here is what stops those four routes from having to ask Temporal for a
    // run id it may no longer remember.
    runId: row.id,
    // The ticket key, not a summary this store does not have. A blank title
    // would render as an unnamed row; the key at least names the ticket, and
    // is what the caller clicks through on.
    title: row.ticketKey,
    appId: row.appId as AppId | null,
    mode: row.mode,
    // `risk` is nullable until the analysis sets it (M51); the read model is
    // not, and "dusuk" would be a claim that the run was assessed as low risk.
    // `orta` is the middle tier and the one the platform defaults an
    // unassessed run to elsewhere.
    risk: row.risk ?? "orta",
    dataClass: row.dataClass,
    step: row.step,
    // Straight through, NOT defaulted. The column is NOT NULL and carries the
    // platform's verdict; passing it verbatim is what lets the route notice
    // that the row says `fail` while the engine still says `running`.
    status: row.status,
    parentTicketKey: parentOf(row.matchJson),
    childTicketKeys: children ?? [],
    reporter: "",
    assignee: null,
    prId: row.prId,
    costUsd: totals?.costUsd ?? 0,
    tokensIn: totals?.tokensIn ?? 0,
    tokensOut: totals?.tokensOut ?? 0,
    startedAt: row.startedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    // Straight through, `null` and all: `null` is "on the board", and there is
    // no default that could stand in for it — a made-up timestamp here would
    // retire an active run from every listing at once.
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}
