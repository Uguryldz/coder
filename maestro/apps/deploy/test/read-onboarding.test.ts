import { describe, expect, it } from "vitest";
import {
  PrismaOnboardingReader,
  PrismaRepoPolicyReader,
  runSampleDelegate,
  type ApplicationListRow,
  type BindingListRow,
  type RunSampleRow,
} from "../src/stores/read-onboarding.js";

/**
 * The Postgres-backed onboarding and repo-policy readers.
 *
 * The fakes below stand in for Prisma delegates and record the arguments they
 * were called with, because half of what these stores get right is the QUERY:
 * a dry run that filtered by the wrong prefix would sample another project's
 * tickets, and a policy reader that read any run rather than the newest would
 * show a stale deny-list.
 */

function bindings(rows: readonly BindingListRow[]) {
  return {
    findMany: (_args: { orderBy: { projectKey: "asc" }; take: number }) =>
      Promise.resolve([...rows]),
    findUnique: (args: { where: { projectKey: string } }) =>
      Promise.resolve(rows.find((row) => row.projectKey === args.where.projectKey) ?? null),
  };
}

/**
 * Bir `application.findMany` — verilen `where`i UYGULAR ve çağrıyı KAYDEDER.
 *
 * Filtreyi uygulaması şart: proje süzgeci SORGUDA yaşıyor (`stores/routing.ts`
 * ile aynı yerde), yani `where`i yok sayan bir fake, filtrenin var olup
 * olmadığını ölçemez — düzeltme geri alındığında test yine yeşil kalırdı.
 */
function applications(rows: readonly ApplicationListRow[]) {
  const queries: Array<{ where?: { jiraProjectKey: string } }> = [];
  const delegate = {
    queries,
    findMany: (args: { where?: { jiraProjectKey: string }; orderBy: { appId: "asc" }; take: number }) => {
      queries.push(args);
      const owner = args.where?.jiraProjectKey;
      const matched = owner === undefined ? rows : rows.filter((row) => row.jiraProjectKey === owner);
      return Promise.resolve(matched.slice(0, args.take));
    },
    findUnique: (args: { where: { appId: string } }) =>
      Promise.resolve(rows.find((row) => row.appId === args.where.appId) ?? null),
  };
  return delegate;
}

/** A `workflowRun.findMany` that applies the filters it is handed, and records them. */
function runs(rows: readonly RunSampleRow[]) {
  const queries: unknown[] = [];
  return {
    queries,
    delegate: runSampleDelegate({
      findMany: (args: unknown) => {
        queries.push(args);
        const where = (args as { where: { ticketKey?: { startsWith: string }; appId?: string } })
          .where;
        const take = (args as { take: number }).take;
        const matched = rows.filter((row) => {
          if (where.ticketKey !== undefined && !row.ticketKey.startsWith(where.ticketKey.startsWith)) {
            return false;
          }
          return where.appId === undefined || row.appId === where.appId;
        });
        return Promise.resolve(matched.slice(0, take));
      },
    }),
  };
}

/**
 * İki depo, İKİ AYRI Jira projesine ait — ve biri sahipsiz.
 *
 * Üç hâlin üçü de gerçek: bir proje bağlanmış depo, BAŞKA bir projeye bağlanmış
 * depo, ve henüz hiçbirine bağlanmamış depo (içe aktarılmış envanter satırı).
 * Süzgecin ölçülebilmesi için üçü de gerekli — hepsi aynı projeye ait olsaydı,
 * filtreli ve filtresiz liste aynı çıkar ve test hiçbir şey kanıtlamazdı.
 */
const APPS: ApplicationListRow[] = [
  {
    appId: "ugurpay",
    adoProject: "Odeme",
    adoRepo: "ugurpay",
    platform: "linux-node",
    maestroYamlPresent: true,
    jiraProjectKey: "UGURPAY",
  },
  {
    appId: "cards",
    adoProject: "Kart",
    adoRepo: "cards",
    platform: "linux-java",
    maestroYamlPresent: false,
    jiraProjectKey: "KART",
  },
  {
    // Sahipsiz: hiçbir projeye bağlanmamış. Bir hata değil, ama bir projenin
    // listesinde GÖRÜNMEMELİ.
    appId: "legacy",
    adoProject: "Eski",
    adoRepo: "legacy",
    platform: "linux-node",
    maestroYamlPresent: false,
    jiraProjectKey: null,
  },
];

describe("PrismaOnboardingReader", () => {
  it("renders the ADO repo path and offers every platform profile the contract defines", async () => {
    const reader = new PrismaOnboardingReader(
      bindings([{ projectKey: "UGURPAY", state: "active" }]),
      applications(APPS),
      runs([]).delegate,
    );

    const options = await reader.options({ limit: 50, cursor: null });
    // Proje bağlamı VERİLMEDİ → süzgeç uygulanmaz, envanterin tamamı döner.
    // Bu, sihirbazın ilk kurulumda gördüğü liste ve bilerek böyle: bir projenin
    // henüz hiçbir depoya bağlı olmaması, sihirbazın var olma sebebi.
    expect(options.repos).toEqual([
      { appId: "ugurpay", repo: "Odeme/_git/ugurpay", platform: "linux-node" },
      { appId: "cards", repo: "Kart/_git/cards", platform: "linux-java" },
      { appId: "legacy", repo: "Eski/_git/legacy", platform: "linux-node" },
    ]);
    // The whole contract enum, NOT just the profiles already in the registry:
    // deriving from existing apps made the first onboarding impossible (empty
    // registry → no profile → no app could ever be created).
    expect(options.platforms).toEqual([
      "linux-node",
      "linux-android",
      "macos-xcode",
      "windows-dotnet",
    ]);
    expect(options.projects).toEqual([{ projectKey: "UGURPAY", state: "active" }]);
  });

  /**
   * ── PROJE BAĞLAMI VERİLİRSE DEPOLAR O PROJEYE AİT OLANLAR ─────────────────
   *
   * ÖLÇÜLEN KIRIK: bu okuma bütün `Application` satırlarını döndürüyordu, proje
   * ayrımı YOK. `/routing` ekranı ise aynı tabloyu `jiraProjectKey` ile
   * filtreliyor (`apps/deploy/src/stores/routing.ts`). İki ekran farklı liste
   * gösteriyor, ve başka bir Jira projesine ait depo bu projeye bağlanabilir
   * GÖRÜNÜYORDU — bir bankada yanlış depoya yazma iznini açabilecek bir
   * yanlış-anlatım.
   */
  it("proje bağlamı verilirse YALNIZ o projeye ait depoları döndürür", async () => {
    const apps = applications(APPS);
    const reader = new PrismaOnboardingReader(
      bindings([{ projectKey: "UGURPAY", state: "active" }]),
      apps,
      runs([]).delegate,
    );

    const options = await reader.options({ limit: 50, cursor: null, projectKey: "UGURPAY" });
    expect(options.repos.map((repo) => repo.appId)).toEqual(["ugurpay"]);
    // BAŞKA bir projenin deposu ve sahipsiz depo listede YOK — kırığın tam
    // olarak gösterdiği iki satır.
    expect(options.repos.map((repo) => repo.appId)).not.toContain("cards");
    expect(options.repos.map((repo) => repo.appId)).not.toContain("legacy");
  });

  /**
   * SÜZGEÇ SORGUDA, BELLEKTE DEĞİL — ve `/routing` ile aynı alan üzerinden.
   *
   * Bir sayfa dolusu satırı çekip JS'te elemek `take` sınırıyla birleşince
   * sessizce yanlış olurdu: ilk 50 satırın hiçbiri o projeye ait değilse liste
   * boş dönerdi ve operatör "deposu yok" diye okurdu.
   */
  it("süzgeci SORGUYA koyar — sayfa sınırıyla birleşince bellekte elemek yanlış olurdu", async () => {
    const apps = applications(APPS);
    const reader = new PrismaOnboardingReader(bindings([]), apps, runs([]).delegate);

    await reader.options({ limit: 50, cursor: null, projectKey: "KART" });
    expect(apps.queries.at(-1)?.where).toEqual({ jiraProjectKey: "KART" });
  });

  /**
   * ── PROJE BAĞLAMI YOKSA SÜZGEÇ DE YOK — üç çalışan çağıran bozulmasın ─────
   *
   * Sihirbaz (`Onboard.tsx`) ve ilk kurulum ekranı (`Setup.tsx`) listeyi proje
   * SEÇİLMEDEN ÖNCE okuyor; `assertBindable` (`onboarding-service.ts`) ise
   * projeden bağımsız bir soru soruyor ("böyle bir uygulama envanterde var
   * mı"). Koşulsuz bir filtre üçünü birden bozardı: ilk kurulum imkânsız
   * hâle gelir, ve hiçbir projeye bağlanmamış bir depo "bilinmeyen uygulama"
   * diye reddedilirdi.
   */
  it("proje bağlamı yoksa envanterin TAMAMINI döndürür ve sorguya where koymaz", async () => {
    const apps = applications(APPS);
    const reader = new PrismaOnboardingReader(bindings([]), apps, runs([]).delegate);

    const options = await reader.options({ limit: 50, cursor: null });
    expect(options.repos.map((repo) => repo.appId)).toEqual(["ugurpay", "cards", "legacy"]);
    // Anahtar HİÇ yazılmamalı: `where: undefined` ile "where yok" farklı iki
    // şey, ve Prisma'nın ikisini ayırt etmesi gerekiyor.
    expect(Object.hasOwn(apps.queries.at(-1) as object, "where")).toBe(false);
  });

  /**
   * Boş bir proje anahtarı "bağlam yok" demektir, "hiçbir şeye ait olmayanlar"
   * değil: bir tarayıcı boş bir seçim için `?projectKey=` gönderir, ve o isteğe
   * boş liste dönmek, operatöre envanterin boş olduğunu söylemek olurdu.
   */
  it("boş bir proje anahtarını 'bağlam yok' sayar", async () => {
    const apps = applications(APPS);
    const reader = new PrismaOnboardingReader(bindings([]), apps, runs([]).delegate);

    const options = await reader.options({ limit: 50, cursor: null, projectKey: "  " });
    expect(options.repos).toHaveLength(3);
    expect(Object.hasOwn(apps.queries.at(-1) as object, "where")).toBe(false);
  });

  it("keeps bound projects in the list, carrying their state", async () => {
    const reader = new PrismaOnboardingReader(
      bindings([
        { projectKey: "UGURPAY", state: "active" },
        { projectKey: "OLD", state: "unbound" },
      ]),
      applications(APPS),
      runs([]).delegate,
    );

    const options = await reader.options({ limit: 50, cursor: null });
    // Hiding a bound project would make "why is my project missing" an
    // unanswerable question; the state is what the route refuses on.
    expect(options.projects.map((p) => p.state)).toEqual(["active", "unbound"]);
  });

  it("samples by ticket prefix so a sibling project cannot leak in", async () => {
    const rowsFor = [
      row("UGURPAY-1", "ugurpay"),
      row("UGURPAYX-9", "cards"),
      row("UGURPAY-2", "ugurpay"),
    ];
    const runFake = runs(rowsFor);
    const reader = new PrismaOnboardingReader(bindings([]), applications(APPS), runFake.delegate);

    const samples = await reader.recentTickets("UGURPAY", 20);
    // `UGURPAYX-9` is a different project. The separator in the prefix is what
    // keeps it out.
    expect(samples.map((s) => s.ticketKey)).toEqual(["UGURPAY-1", "UGURPAY-2"]);
    expect(runFake.queries[0]).toMatchObject({
      where: { ticketKey: { startsWith: "UGURPAY-" } },
      orderBy: { startedAt: "desc" },
      take: 20,
    });
  });

  it("honours the limit it is given", async () => {
    const runFake = runs([row("A-1", "ugurpay"), row("A-2", "ugurpay"), row("A-3", "ugurpay")]);
    const reader = new PrismaOnboardingReader(bindings([]), applications(APPS), runFake.delegate);

    expect(await reader.recentTickets("A", 2)).toHaveLength(2);
  });

  it("returns null for a project with no binding row", async () => {
    const reader = new PrismaOnboardingReader(bindings([]), applications(APPS), runs([]).delegate);
    expect(await reader.binding("NOPE")).toBeNull();
  });
});

describe("PrismaRepoPolicyReader", () => {
  it("assembles the policy from the newest run of the application", async () => {
    const runFake = runs([
      {
        ticketKey: "UGURPAY-1",
        appId: "ugurpay",
        matchJson: null,
        protectedPathsJson: ["src/payment-core/**"],
        verificationJson: [{ name: "lint", command: ["pnpm", "lint"] }],
        updatedAt: new Date("2026-08-08T10:00:00.000Z"),
      },
    ]);
    const reader = new PrismaRepoPolicyReader(applications(APPS), runFake.delegate);

    const record = await reader.get("ugurpay");
    expect(record).toMatchObject({
      appId: "ugurpay",
      repo: "Odeme/_git/ugurpay",
      yamlPresent: true,
      repoAdditions: ["src/payment-core/**"],
      observedAt: "2026-08-08T10:00:00.000Z",
    });
    expect(record?.verification).toEqual([{ name: "lint", command: ["pnpm", "lint"] }]);
    // Newest first, one row: a stale run must not supply the deny-list.
    expect(runFake.queries[0]).toMatchObject({ orderBy: { startedAt: "desc" }, take: 1 });
  });

  it("reports never-observed rather than an empty policy", async () => {
    const reader = new PrismaRepoPolicyReader(applications(APPS), runs([]).delegate);

    const record = await reader.get("cards");
    // `observedAt: null` is the field that separates "we looked and it was
    // empty" from "we never looked". The screen renders them differently.
    expect(record).toMatchObject({ observedAt: null, repoAdditions: [], verification: [] });
  });

  it("returns null for an application that is not in the registry", async () => {
    const reader = new PrismaRepoPolicyReader(applications(APPS), runs([]).delegate);
    expect(await reader.get("nosuchapp")).toBeNull();
  });

  it("drops a malformed deny-list whole rather than half of it", async () => {
    const runFake = runs([
      {
        ticketKey: "UGURPAY-1",
        appId: "ugurpay",
        matchJson: null,
        // One entry is not a string. A partial list would show the operator
        // fewer protections than the runner enforces.
        protectedPathsJson: ["src/a/**", 42],
        verificationJson: [{ name: "lint", command: ["pnpm", 7] }],
        updatedAt: new Date("2026-08-08T10:00:00.000Z"),
      },
    ]);
    const reader = new PrismaRepoPolicyReader(applications(APPS), runFake.delegate);

    const record = await reader.get("ugurpay");
    expect(record?.repoAdditions).toEqual([]);
    expect(record?.verification).toEqual([]);
  });
});

function row(ticketKey: string, appId: string): RunSampleRow {
  return {
    ticketKey,
    appId,
    matchJson: { via: "rule", ruleId: "r-1", appId },
    protectedPathsJson: null,
    verificationJson: null,
    updatedAt: new Date("2026-08-08T10:00:00.000Z"),
  };
}
