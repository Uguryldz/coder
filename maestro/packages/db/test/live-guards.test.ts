import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/index.js";
import { allMigrationSql, readGuardsMigration, readMigration } from "./paths.js";

/**
 * Behavioural proof of migration `0002`: the guards are only real if a client
 * that tries to break them actually fails.
 *
 * This file needs a live, throwaway Postgres, so it is opt-in:
 *
 *   docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=maestro \
 *     -e POSTGRES_DB=maestro_test --name maestro-pg postgres:16-alpine
 *   TEST_DATABASE_URL=postgresql://postgres:maestro@localhost:55432/maestro_test \
 *     pnpm -F @maestro/db test
 *
 * The rest of the suite stays offline (the wave gate runs without a database),
 * and the same assertions are made against the migration *text* in
 * `test/migration.test.ts`, so a deleted trigger fails the offline suite too.
 */
const url = process.env["TEST_DATABASE_URL"];

/**
 * Split a migration into statements. `;` inside a `$$ … $$` dollar-quoted body
 * (the plpgsql trigger function) is not a statement boundary — splitting naively
 * would cut the function in half and the guard would silently not be installed.
 *
 * Neither is a `;` inside a SINGLE-QUOTED string, and that one was missed until
 * it cost something. `0019`'un `COMMENT ON COLUMN` metni cümlenin ortasında bir
 * `;` taşıyor ("…is never deleted; archiving hides it…"), yani `allMigrationSql()`
 * yüklemeye çalışan HER blok o noktada yarım bir ifade gönderiyor ve Postgres
 * `unterminated quoted string` diyordu. Bir `beforeAll` hatası bloğun tamamını
 * atlanmış gösterdiği için de kimse fark etmiyordu: `durable-store guards`
 * canlı bir veritabanıyla bile ÇALIŞMIYORDU, yalnız "skipped" yazıyordu.
 *
 * SQL'de tek tırnak, iki tırnakla (`''`) kaçırılır — ayrı bir kaçış karakteri
 * yoktur. Döngü bu yüzden tırnağı görünce durumu çeviriyor: `''` arka arkaya
 * iki çevirme demek, yani dizenin içinde kalınır ve ayrıca ele alınması gerekmez.
 */
export function splitSqlStatements(sql: string): string[] {
  // Comments go first: a prose `;` inside a `--` line would otherwise look like
  // a statement boundary and cut the comment in half.
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  const statements: string[] = [];
  let current = "";
  let inDollarQuote = false;
  let inSingleQuote = false;
  for (let i = 0; i < withoutComments.length; i++) {
    if (!inSingleQuote && withoutComments.startsWith("$$", i)) {
      inDollarQuote = !inDollarQuote;
      current += "$$";
      i += 1;
      continue;
    }
    const char = withoutComments[i] ?? "";
    // Dolar-tırnaklı gövdenin içindeki `'` bir dize başlatmaz: orası plpgsql
    // kaynağı ve kendi tırnaklama kuralları var.
    if (char === "'" && !inDollarQuote) {
      inSingleQuote = !inSingleQuote;
      current += char;
      continue;
    }
    if (char === ";" && !inDollarQuote && !inSingleQuote) {
      statements.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

describe("splitSqlStatements", () => {
  it("keeps a dollar-quoted function body in one piece", () => {
    const parts = splitSqlStatements(
      `CREATE FUNCTION f() RETURNS trigger AS $$\nBEGIN\n  RAISE EXCEPTION 'x';\nEND;\n$$ LANGUAGE plpgsql;\nSELECT 1;`,
    );
    expect(parts.length).toBe(2);
    expect(parts[0]).toContain("RAISE EXCEPTION");
    expect(parts[1]).toBe("SELECT 1");
  });

  it("drops comment lines before looking for a boundary, prose semicolons included", () => {
    const parts = splitSqlStatements(`-- one thing; another thing\nSELECT 1;\n-- trailing\n`);
    expect(parts).toEqual(["SELECT 1"]);
  });

  /**
   * 0019'un `COMMENT ON COLUMN` metni cümlenin ortasında bir `;` taşıyor, ve
   * bu splitter onu ifade sınırı sanıp her canlı-DB bloğunu `beforeAll`da
   * düşürüyordu — bloklar da "skipped" göründüğü için kimse fark etmiyordu.
   */
  it("keeps a semicolon inside a single-quoted string out of the boundary count", () => {
    const parts = splitSqlStatements(
      `COMMENT ON COLUMN "t"."c" IS 'never deleted; only hidden';\nSELECT 1;`,
    );
    expect(parts).toEqual([`COMMENT ON COLUMN "t"."c" IS 'never deleted; only hidden'`, "SELECT 1"]);
  });

  /** SQL'de tırnak `''` ile kaçırılır; iki çevirme dizenin içinde bırakır. */
  it("handles a doubled single quote inside a string", () => {
    const parts = splitSqlStatements(`SELECT 'dashboard''s view; here';\nSELECT 2;`);
    expect(parts).toEqual([`SELECT 'dashboard''s view; here'`, "SELECT 2"]);
  });
});

describe.skipIf(url === undefined || url.trim().length === 0)("database guards (live)", () => {
  let db: Db;

  beforeAll(async () => {
    db = createDb(url as string, { log: ["error"] });
    await db.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await db.$executeRawUnsafe("CREATE SCHEMA public");
    for (const sql of [readMigration(), readGuardsMigration()]) {
      for (const statement of splitSqlStatements(sql)) {
        await db.$executeRawUnsafe(statement);
      }
    }
    await db.$executeRawUnsafe(
      `INSERT INTO "WorkflowRun" ("id","ticketKey","mode","dataClass","step","status","startedAt","updatedAt")
       VALUES ('run-live-1','LIVE-1','full_auto','dahili','3','running', now(), now())`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "JournalEntry" ("runId","seq","at","actor","kind","title","detail")
       VALUES ('run-live-1', 0, now(), 'system', 'intake', 'first', '')`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "AuditLog" ("seq","at","actor","action","subject","prevHash","hash")
       VALUES (1, now(), 'maestro-worker', 'RUN_STARTED', 'LIVE-1', 'genesis', '${"a".repeat(64)}')`,
    );
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("refuses an UPDATE on the journal", async () => {
    await expect(
      db.$executeRawUnsafe(`UPDATE "JournalEntry" SET "title" = 'rewritten' WHERE "seq" = 0`),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses a DELETE on the journal", async () => {
    await expect(
      db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "seq" = 0`),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses an UPDATE on the audit log", async () => {
    await expect(
      db.$executeRawUnsafe(`UPDATE "AuditLog" SET "actor" = 'mallory' WHERE "seq" = 1`),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses a DELETE and a TRUNCATE on the audit log", async () => {
    await expect(db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "seq" = 1`)).rejects.toThrow(
      /append-only/,
    );
    await expect(db.$executeRawUnsafe(`TRUNCATE "AuditLog"`)).rejects.toThrow(/append-only/);
  });

  it("refuses a second record pointing at the same predecessor (no forked chain)", async () => {
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("seq","at","actor","action","subject","prevHash","hash")
         VALUES (2, now(), 'maestro-worker', 'RUN_CLOSED', 'LIVE-1', 'genesis', '${"b".repeat(64)}')`,
      ),
    ).rejects.toThrow(/\("prevHash"\)=\(genesis\) already exists/);
  });

  it("refuses a guarded parameter version with no approver (four eyes)", async () => {
    await db.$executeRawUnsafe(
      `INSERT INTO "Param" ("key","scope","type","guarded","defJson")
       VALUES ('merge.mode','project','enum', true, '{}'::jsonb)`,
    );
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "ParamVersion" ("key","scopeRef","version","valueJson","guarded","changedBy","at")
         VALUES ('merge.mode','',1,'"auto_merge"'::jsonb, true, 'ugur@corp', now())`,
      ),
    ).rejects.toThrow(/ParamVersion_guarded_needs_approver/);

    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "ParamVersion" ("key","scopeRef","version","valueJson","guarded","changedBy","approvedBy","at")
         VALUES ('merge.mode','',1,'"auto_merge"'::jsonb, true, 'ugur@corp', 'mert@corp', now())`,
      ),
    ).resolves.toBe(1);
  });

  it("allows a ticket to be re-run, but never two live runs at once", async () => {
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "WorkflowRun" ("id","ticketKey","mode","dataClass","step","status","startedAt","updatedAt")
         VALUES ('run-live-2','LIVE-1','full_auto','dahili','0','running', now(), now())`,
      ),
    ).rejects.toThrow(/\("ticketKey"\)=\(LIVE-1\) already exists/);

    // Cancel the first run, and the ticket may start over.
    await db.$executeRawUnsafe(`UPDATE "WorkflowRun" SET "status" = 'cancelled' WHERE "id" = 'run-live-1'`);
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "WorkflowRun" ("id","ticketKey","mode","dataClass","step","status","startedAt","updatedAt")
         VALUES ('run-live-2','LIVE-1','full_auto','dahili','0','running', now(), now())`,
      ),
    ).resolves.toBe(1);
  });
});

/**
 * Behavioural proof of migration `0008` (Dalga E): the durable-store guards are
 * only real if a client that tries to break them fails. Same opt-in switch and
 * same offline-text mirror (`test/migration.test.ts`) as the block above.
 *
 * A fresh schema loading ALL migrations, so `Session` and `KillSwitch` exist —
 * they arrive in 0008, which the block above deliberately does not load.
 */
describe.skipIf(url === undefined || url.trim().length === 0)("durable-store guards (live)", () => {
  let db: Db;

  beforeAll(async () => {
    db = createDb(url as string, { log: ["error"] });
    await db.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await db.$executeRawUnsafe("CREATE SCHEMA public");
    for (const statement of splitSqlStatements(allMigrationSql())) {
      await db.$executeRawUnsafe(statement);
    }
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("refuses a session that expires before it was issued", async () => {
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "Session" ("token","userId","username","rolesJson","groupsJson","issuedAt","expiresAt")
         VALUES ('t1','ugur@corp','ugur','[]'::jsonb,'[]'::jsonb, now(), now() - interval '1 hour')`,
      ),
    ).rejects.toThrow(/Session_expiry_after_issue/);
  });

  it("allows exactly one kill-switch row and refuses a second (M58)", async () => {
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "KillSwitch" ("id","level","actor","reason","at")
         VALUES ('ONLY','all','ugur@corp','incident', now())`,
      ),
    ).resolves.toBe(1);
    // A second row with a different id is refused by the single-row CHECK.
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "KillSwitch" ("id","level","actor","reason","at")
         VALUES ('OTHER','off','mert@corp','none', now())`,
      ),
    ).rejects.toThrow(/KillSwitch_single_row/);
  });

  it("refuses a kill-switch level the platform cannot read — a brake must never fail open", async () => {
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "KillSwitch" SET "level" = 'paused' WHERE "id" = 'ONLY'`,
      ),
    ).rejects.toThrow(/KillSwitch_level_valid/);
  });
});

/**
 * EMEKLİYE AYIRMA, GERÇEK BİR POSTGRES'TE — bu bloğun var olma sebebi bir saha
 * arızası, ve arızanın tekrar etmemesinin tek yolu.
 *
 * ── Ne olmuştu ────────────────────────────────────────────────────────────
 * Ölü bir koşuyu emekliye ayırmak `WorkflowRun.id`'yi değiştirerek yapılıyordu
 * ve bellek-içi fake'lerde kusursuz çalışıyordu. Gerçek Postgres'te ise
 * `JournalEntry.runId` bu kolona `onUpdate: Cascade` ile bağlı: birincil
 * anahtarı değiştirmek veritabanına `UPDATE "JournalEntry" SET "runId" = …`
 * yazdırıyor — ve `JournalEntry` M30/M33 tetikleyicisiyle YALNIZCA-EKLEME.
 * Yazı P0001 ile reddediliyor, emekliye ayırma yeniden başlatmanın İLK adımı
 * olduğu için de hem operatörün "Yeniden başlat" düğmesi (500) hem otomatik
 * tarama turu kırılıyordu: ölü koşusu olan ticket KALICI olarak akış dışı
 * kalıyordu. Defteri korumak için konan kural, defteri taşımayı engelliyordu.
 *
 * ── Neden CANLI bir veritabanı şart ───────────────────────────────────────
 * Fake'in izin verdiği bir şeyi gerçek veritabanı reddediyordu, ve o farkı
 * hiçbir fake gösteremez: cascade de tetikleyici de Postgres'in kendi
 * davranışı. Bu blok üç şeyi birden çiviliyor — kimlik değiştirmek HÂLÂ
 * reddedilir (append-only garantisi delinmedi), emekliye ayırmanın gerçek yolu
 * (statü + arşiv) çalışır, ve emekliye ayrılmış bir ticket gerçekten yeniden
 * akışa alınabilir.
 *
 * TÜM migrationlar yükleniyor, çünkü `WorkflowRun.archivedAt` 0019'da geliyor
 * ve yukarıdaki ilk blok bilerek yalnız 0001+0002 yüklüyor.
 */
describe.skipIf(url === undefined || url.trim().length === 0)(
  "emekliye ayırma — append-only defterin altında (live)",
  () => {
    let db: Db;

    beforeAll(async () => {
      db = createDb(url as string, { log: ["error"] });
      await db.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
      await db.$executeRawUnsafe("CREATE SCHEMA public");
      for (const statement of splitSqlStatements(allMigrationSql())) {
        await db.$executeRawUnsafe(statement);
      }
      // Ölü bir koşu ve onun defteri — sahadaki OTYT-1'in şekli.
      await db.$executeRawUnsafe(
        `INSERT INTO "WorkflowRun" ("id","ticketKey","mode","dataClass","step","status","startedAt","updatedAt")
         VALUES ('maestro-RET-1','RET-1','full_auto','dahili','3','running', now(), now())`,
      );
      await db.$executeRawUnsafe(
        `INSERT INTO "JournalEntry" ("runId","seq","at","actor","kind","title","detail")
         VALUES ('maestro-RET-1', 0, now(), 'ai', 'analysis', 'analiz yazıldı', 'risk: yuksek')`,
      );
    }, 120_000);

    afterAll(async () => {
      await db?.$disconnect();
    });

    /**
     * ESKİ YOL HÂLÂ REDDEDİLİR — append-only garantisi delinmedi.
     *
     * Bu tam olarak eski `retire`in yaptığı yazı. Geçmesi, denetim zincirinin
     * temelinde bir delik açıldığı anlamına gelirdi; reddedilmesi, düzeltmenin
     * kuralı gevşeterek değil kuralın ETRAFINDAN dolaşarak yapıldığının kanıtı.
     */
    it("bir koşunun KİMLİĞİNİ değiştirmeyi reddeder — defterin cascade UPDATE'i yalnızca-ekleme duvarına çarpar", async () => {
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "WorkflowRun" SET "id" = 'maestro-RET-1#emekli-1' WHERE "id" = 'maestro-RET-1'`,
        ),
      ).rejects.toThrow(/append-only/);
    });

    /** Ve defter, o reddedilen yazıdan sonra da yerinde ve bozulmamış. */
    it("reddedilen yazı defteri kırpmaz — satır olduğu gibi duruyor", async () => {
      const journal = await db.$queryRawUnsafe<Array<{ runId: string; title: string }>>(
        `SELECT "runId", "title" FROM "JournalEntry" WHERE "runId" = 'maestro-RET-1'`,
      );
      expect(journal).toEqual([{ runId: "maestro-RET-1", title: "analiz yazıldı" }]);
    });

    /**
     * EMEKLİYE AYIRMANIN GERÇEK YAZISI — `PrismaRunCatalog.retire`in bugün
     * yaptığı şeyin aynısı, ham SQL olarak.
     */
    it("statü + arşiv damgası GEÇER — kimliğe dokunulmadığı için defter hiç yazılmaz", async () => {
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "WorkflowRun" SET "status" = 'fail', "archivedAt" = now() WHERE "id" = 'maestro-RET-1'`,
        ),
      ).resolves.toBe(1);
    });

    /**
     * GEÇMİŞ KAYBOLMADI, ve `priorWork`in onu bulma yolu çalışmaya devam
     * ediyor: `ticketKey` + `archivedAt not null`. O sorgu kimliğe hiç
     * bakmıyor, dolayısıyla kimliğin sabit kalması onu hiç etkilemiyor.
     */
    it("emekli satır ve defteri okunabilir kalır — priorWork'ün sorgusu bulur", async () => {
      const retired = await db.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "WorkflowRun" WHERE "ticketKey" = 'RET-1' AND "archivedAt" IS NOT NULL`,
      );
      expect(retired.map((r) => r.id)).toEqual(["maestro-RET-1"]);

      const journal = await db.$queryRawUnsafe<Array<{ title: string }>>(
        `SELECT "title" FROM "JournalEntry" WHERE "runId" = 'maestro-RET-1'`,
      );
      expect(journal.map((j) => j.title)).toEqual(["analiz yazıldı"]);
    });

    /**
     * VE TICKET GERÇEKTEN YENİDEN AKIŞA ALINABİLİYOR — emekliye ayırmanın
     * AMACI buydu, ve sahada tam olarak bu olmuyordu.
     *
     * Eski satır kimliğini koruduğu için yeni koşu farklı bir ad alıyor
     * (`PrismaRunContextStore.create` ticket'ın boş kimliğini seçiyor), ve
     * kısmi unique indeks eski satır terminal olduğu için buna izin veriyor.
     */
    it("emekliye ayrılmış ticket YENİDEN başlatılabilir — yeni koşu kendi kimliğiyle açılır", async () => {
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO "WorkflowRun" ("id","ticketKey","mode","dataClass","step","status","startedAt","updatedAt")
           VALUES ('maestro-RET-1-2','RET-1','full_auto','dahili','0','running', now(), now())`,
        ),
      ).resolves.toBe(1);

      // İki satır: emekli olan ve yeni olan. Geçmiş yanında duruyor.
      const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "WorkflowRun" WHERE "ticketKey" = 'RET-1' ORDER BY "id"`,
      );
      expect(rows.map((r) => r.id)).toEqual(["maestro-RET-1", "maestro-RET-1-2"]);
    });

    /**
     * VE İKİNCİ KEZ — iki kez düşen bir koşu sıradan bir şey, ve sıra
     * tıkanmamalı. Eski tasarımda ikinci emeklilik sabit bir son ekle yine
     * çakışırdı; burada sıra numarası ilerliyor.
     */
    it("aynı ticket İKİNCİ kez emekliye ayrılıp üçüncü kez başlatılabilir", async () => {
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "WorkflowRun" SET "status" = 'fail', "archivedAt" = now() WHERE "id" = 'maestro-RET-1-2'`,
        ),
      ).resolves.toBe(1);
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO "WorkflowRun" ("id","ticketKey","mode","dataClass","step","status","startedAt","updatedAt")
           VALUES ('maestro-RET-1-3','RET-1','full_auto','dahili','0','running', now(), now())`,
        ),
      ).resolves.toBe(1);
    });

    /**
     * VE İKİ CANLI KOŞU HÂLÂ İMKÂNSIZ — emekliye ayırma bu garantiyi
     * gevşetmedi. Bir önceki test canlı bir satır bıraktı; ikincisi reddedilir.
     */
    it("emekliye ayırma iki canlı koşu kapısını AÇMAZ", async () => {
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO "WorkflowRun" ("id","ticketKey","mode","dataClass","step","status","startedAt","updatedAt")
           VALUES ('maestro-RET-1-4','RET-1','full_auto','dahili','0','running', now(), now())`,
        ),
      ).rejects.toThrow(/\("ticketKey"\)=\(RET-1\) already exists/);
    });
  },
);
