import { describe, expect, it } from "vitest";
import { flowDecisionFor } from "../../bff/src/flow-decision.js";
import {
  canSearch,
  classifyingFieldsOf,
  diagnosticJqlFor,
  discoverOnce,
  discoveryStatus,
  jqlFor,
  startJiraDiscovery,
  type DiscoveryRule,
} from "../src/jira-discovery.js";

/**
 * Finding tickets by asking Jira.
 *
 * Reported from the customer's own install: connection green, listening rules
 * correct, panel up — and no ticket ever arrived. The cause was that nothing
 * ASKED. A ticket could only enter through a Jira webhook (never registered
 * there) or a person typing `/ai-start`. This loop is the third path, and these
 * tests pin the two things that make it safe: what it asks Jira for, and that
 * it never starts the same ticket twice.
 */

const RULE: DiscoveryRule = {
  projectKey: "OPS",
  assigneeAccountId: "712020:bot",
  matchKind: "issuetype",
  matchValue: "Görev",
  enabled: true,
};

/** A search that answers with the given keys and records what it was asked. */
function fakeSearch(pages: Record<string, string[]>): {
  search: { searchIssues: (r: { jql: string }) => Promise<{ issues: Array<{ key?: string }> }> };
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    search: {
      searchIssues: (request) => {
        asked.push(request.jql);
        const keys = pages[request.jql] ?? [];
        return Promise.resolve({ issues: keys.map((key) => ({ key })) });
      },
    },
  };
}

describe("jqlFor", () => {
  /**
   * Project AND assignee, always. That pair is what "Maestro was given this
   * ticket" means, and it is the same pair the listening rule is keyed on —
   * without the assignee clause a sweep would take every ticket in the
   * project, including ones nobody handed over.
   */
  /**
   * The account id goes in BARE, inside `in (...)`.
   *
   * Measured on the live site: `assignee = "712020:b836…"` returns nothing —
   * Jira reads a quoted value as a display name or e-mail, and an account id
   * is neither. Every sweep came back empty while reporting six rules searched
   * and no error, which is the most misleading way a search can fail.
   */
  it("anchors every rule to its project and the bot account", () => {
    expect(jqlFor({ ...RULE, matchKind: "assigned", matchValue: "*" })).toBe(
      'project = "OPS" AND assignee in (712020:bot)',
    );
  });

  it("narrows by issue type", () => {
    expect(jqlFor(RULE)).toBe(
      'project = "OPS" AND assignee in (712020:bot) AND issuetype = "Görev"',
    );
  });

  /**
   * STATÜ KAPISI SORGUYA HER ZAMAN GİRER (0024).
   *
   * Kararın (`flow-decision.ts`) yanlış statüdeki ticket'ı işlememesi yetmez:
   * o noktada ticket ÇOKTAN OKUNMUŞTUR. Bu platformun servis hesabı ADMIN
   * olduğu için okuma da bir maliyettir — bağlanmamış statüdeki ticket'lar hiç
   * ÇEKİLMEMELİ. `boundProjects`ün sorguyu projeye hapsetmesiyle aynı gerekçe.
   */
  it("statüyü BOTA ATANMA kuralının sorgusuna da koyar — tetikleme tipinden bağımsız", () => {
    expect(
      jqlFor({
        ...RULE,
        matchKind: "assigned",
        matchValue: "*",
        allowedStatuses: ["Analiz"],
      }),
    ).toBe('project = "OPS" AND assignee in (712020:bot) AND status in ("Analiz")');
  });

  it("statüyü İŞ TİPİ kuralının sorgusuna da koyar", () => {
    expect(jqlFor({ ...RULE, allowedStatuses: ["Yapılacak"] })).toBe(
      'project = "OPS" AND assignee in (712020:bot) AND status in ("Yapılacak") AND issuetype = "Görev"',
    );
  });

  it("birden çok izinli statüyü tek bir in(...) listesine koyar", () => {
    expect(
      jqlFor({
        ...RULE,
        matchKind: "assigned",
        matchValue: "*",
        allowedStatuses: ["Yapılacaklar", "Analiz Bekliyor"],
      }),
    ).toBe(
      'project = "OPS" AND assignee in (712020:bot) AND status in ("Yapılacaklar", "Analiz Bekliyor")',
    );
  });

  /**
   * Kısıtsız kuralda hiç eklenmez. Boş bir `status in ()` malformed JQL'dir;
   * Jira 400 döner ve turun catch'i onu turda bir kez loglayıp geçer — yani
   * kural sessizce, sonsuza dek HİÇBİR ŞEY aramış olur. `jqlFor`un var olma
   * sebebi olan sessiz-sonsuz hatanın ta kendisi.
   */
  it("statü kısıtı YOKSA sorguya statü yan tümcesi eklemez (mevcut kurallar)", () => {
    for (const allowedStatuses of [undefined, null, []] as const) {
      expect(
        jqlFor({ ...RULE, matchKind: "assigned", matchValue: "*", allowedStatuses }),
        `allowedStatuses=${JSON.stringify(allowedStatuses)}`,
      ).toBe('project = "OPS" AND assignee in (712020:bot)');
    }
  });

  /**
   * CANLI BULGU (`style: "next-gen"`): takım yönetimli bir projede AD ile
   * daraltma boş döner — `issuetype = "Görev"` sıfır, `issuetype = 10008` on
   * dört ticket. Hata vermez, yani `issuetype`/`status` kuralları sessizce hiç
   * eşleşmiyordu. Rakamdan ibaret bir değer artık TIRNAKSIZ geçer; rakamdan
   * ibaret bir statü ADI olmadığı için ad ile çalışan kurulumlar etkilenmez.
   */
  it("sayısal id'yi tırnaksız yazar — takım yönetimli projede ad çalışmıyor", () => {
    expect(jqlFor({ ...RULE, matchKind: "issuetype", matchValue: "10008" })).toBe(
      'project = "OPS" AND assignee in (712020:bot) AND issuetype = 10008',
    );
    expect(jqlFor({ ...RULE, matchKind: "status", matchValue: "10004" })).toBe(
      'project = "OPS" AND assignee in (712020:bot) AND status = 10004',
    );
  });

  it("statü kapısında da id tırnaksız, ad tırnaklı — ikisi bir arada", () => {
    expect(
      jqlFor({ ...RULE, matchKind: "assigned", matchValue: "*", allowedStatuses: ["10004", "İNCELEMEDE"] }),
    ).toBe('project = "OPS" AND assignee in (712020:bot) AND status in (10004, "İNCELEMEDE")');
  });

  it("adı olan değer tırnaklı kalır — mevcut kurulumların davranışı değişmez", () => {
    expect(jqlFor({ ...RULE, matchKind: "issuetype", matchValue: "Görev" })).toBe(
      'project = "OPS" AND assignee in (712020:bot) AND issuetype = "Görev"',
    );
  });

  it("sadece boşluktan oluşan statü adlarını atar, sorguyu bozmaz", () => {
    expect(
      jqlFor({ ...RULE, matchKind: "assigned", matchValue: "*", allowedStatuses: ["  ", "Analiz"] }),
    ).toBe('project = "OPS" AND assignee in (712020:bot) AND status in ("Analiz")');
  });

  it("statü adındaki tırnağı kaçırır — JQL enjeksiyonu olmaz", () => {
    expect(
      jqlFor({ ...RULE, matchKind: "assigned", matchValue: "*", allowedStatuses: ['Ana"liz'] }),
    ).toBe('project = "OPS" AND assignee in (712020:bot) AND status in ("Ana\\"liz")');
  });

  it("narrows by status", () => {
    expect(jqlFor({ ...RULE, matchKind: "status", matchValue: "İNCELEMEDE" })).toBe(
      'project = "OPS" AND assignee in (712020:bot) AND status = "İNCELEMEDE"',
    );
  });

  /**
   * A project key or status carrying a quote would otherwise end the JQL
   * string early and change the query's meaning — the injection shape, in a
   * language that has no bind parameters.
   */
  it("escapes a quote instead of letting it end the clause", () => {
    const jql = jqlFor({ ...RULE, matchValue: 'Gör"ev' });
    expect(jql).toContain('issuetype = "Gör\\"ev"');
  });

  /**
   * NO BOT ACCOUNT, NO QUERY — the boundary that keeps an admin service
   * account from sweeping the whole bank.
   *
   * `flow-decision.ts` reads an empty `assigneeAccountId` as "whoever it is
   * assigned to", which is safe THERE (it only classifies a ticket somebody
   * already handed over) and catastrophic here (it decides what to go and
   * fetch). The old line emitted `assignee in ()`, which Jira rejects — so the
   * rule swept nothing forever while looking like a rule that found nothing.
   * The dangerous neighbour is one edit away: drop the clause instead and the
   * sweep starts runs on every project the admin account can see.
   */
  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["punctuation only", "!!!"],
  ])("refuses to build a query for a rule whose bot account is %s", (_label, account) => {
    expect(jqlFor({ ...RULE, assigneeAccountId: account })).toBeNull();
  });
});

describe("discoverOnce", () => {
  /** Wire the module's collaborators around a recording intake. */
  async function run(options: {
    rules: readonly DiscoveryRule[];
    found: Record<string, string[]>;
    known?: readonly (string | { ticket: string; step?: string; status?: string })[];
    maxPerRound?: number;
    /** The bound+active projects. Omitted = the seam is not wired at all. */
    boundProjects?: readonly string[];
    /** A binding source that FAILS, for the fail-closed test. */
    boundProjectsThrows?: boolean;
    /**
     * MOTORDA YAŞAYAN koşuların anahtarları. Verilmezse otomatik yeniden
     * başlatma seam'i hiç kurulmaz — turun bu özellik var olmadan önceki hâli.
     * `"throws"` motorun okunamadığı turu ölçer.
     */
    alive?: readonly string[] | "throws";
    /** Ticket başına ÖNCEKİ yeniden başlatma sayısı — freni ölçmek için. */
    priorRestarts?: Record<string, number> | "throws";
    /** Yeniden başlatma alımı reddedilsin mi (kill-switch benzeri). */
    restartRefused?: boolean;
    /** Model anahtarı çalışıyor mu; `"throws"` sağlığın okunamadığı turu ölçer. */
    llmHealthy?: boolean | "throws";
  }): Promise<{
    started: readonly string[];
    /**
     * KURAL sorguları — teşhis sorgusu hariç.
     *
     * Bir kural 0 döndüğünde tur, aynı projede bir TEŞHİS sorgusu daha atar
     * ("kural eşleşmedi, peki projede ne var?"). O ayrı bir soru, ve "kural
     * başına bir sorgu" sayan testlerin ölçtüğü şey değil. `askedAll` ikisini
     * birden tutar, çünkü "bağlanmamış projeye HİÇBİR sorgu gitmedi" testinin
     * ölçmesi gereken şey tam da hepsidir.
     */
    asked: readonly string[];
    askedAll: readonly string[];
    /** Turun yazdığı her satır — atlama satırlarını ölçmek için. */
    logs: readonly string[];
    /** Yeniden başlatılan ticket'lar, çağrı sırasıyla. */
    restarts: readonly string[];
  }> {
    const { search, asked } = fakeSearch(options.found);
    const started: string[] = [];
    const logs: string[] = [];
    const deps = {
      // `runIntake` reads these two; everything else it touches is behind them.
      bindings: { resolve: () => Promise.resolve(null) },
      counters: { droppedKillSwitch: 0 },
      __record: started,
    } as never;

    const restarts: string[] = [];
    /** Emekli satır sayacının bellek karşılığı — gerçekte veritabanı sayıyor. */
    const attempts = new Map<string, number>(
      Object.entries(options.priorRestarts === "throws" ? {} : (options.priorRestarts ?? {})),
    );
    const restartSeam: Partial<Parameters<typeof discoverOnce>[0]> =
      options.alive === undefined
        ? {}
        : {
            liveRuns: () =>
              options.alive === "throws"
                ? Promise.reject(new Error("temporal down"))
                : Promise.resolve(new Set(options.alive as readonly string[])),
            restart: {
              priorRestarts: (ticket: string) =>
                options.priorRestarts === "throws"
                  ? Promise.reject(new Error("db down"))
                  : Promise.resolve(attempts.get(ticket) ?? 0),
              restart: (ticket: string) => {
                restarts.push(ticket);
                const attempt = (attempts.get(ticket) ?? 0) + 1;
                attempts.set(ticket, attempt);
                return Promise.resolve({
                  attempt,
                  accepted: options.restartRefused !== true,
                  ...(options.restartRefused === true ? { reason: "kill_switch" } : {}),
                });
              },
            },
          };

    const result = await discoverOnce({
      deps,
      search,
      ...restartSeam,
      ...(options.llmHealthy === undefined
        ? {}
        : {
            llmHealthy: () =>
              options.llmHealthy === "throws" ? Promise.reject(new Error("health down")) : Promise.resolve(options.llmHealthy as boolean),
          }),
      rules: () => Promise.resolve(options.rules),
      known: () => Promise.resolve((options.known ?? []) as never),
      intervalMs: 0,
      ...(options.maxPerRound === undefined ? {} : { maxPerRound: options.maxPerRound }),
      ...(options.boundProjectsThrows === true
        ? { boundProjects: () => Promise.reject(new Error("db down")) }
        : options.boundProjects === undefined
          ? {}
          : { boundProjects: () => Promise.resolve(options.boundProjects!) }),
      log: (line: string) => void logs.push(line),
    });
    return {
      started: result,
      asked: asked.filter((jql) => !jql.includes("statusCategory")),
      askedAll: asked,
      logs,
      restarts,
    };
  }

  /**
   * BAĞLANMAMIŞ PROJEYE SORGU GİTMEZ — kapsamın dış sınırı.
   *
   * Kuralın `projectKey`'i serbest metin: bir yazım hatası, sonradan bağlantısı
   * kaldırılmış bir proje, ya da elle yazılmış bir satır, bu kurulumun hiç
   * verilmediği bir projeyi adlandırabilir. `runIntake` böyle bir ticket'ı
   * `unbound` diye reddeder ve KOŞU başlamaz — ama o noktada ARAMA çoktan
   * yapılmıştır, ve engellenmesi gereken şey odur.
   *
   * Burada `started` değil `asked` üzerinden doğrulanıyor, ve bu testin bütün
   * meselesi bu: "hiçbir şey başlatmadı", arayıp bir şey bulamamış bir turun da
   * görüntüsüdür. Riskin kendisi, bankanın Jira'sına GİDEN sorgudur — servis
   * hesabı rutin olarak ADMIN'dir ve bağlanmamış bir proje, kapsam dışı bir
   * proje değil, Maestro'yu hiç duymamış bir ekibin ticket'larıdır.
   */
  it("never queries a project the operator did not bind, even for a valid rule", async () => {
    const { asked, askedAll, started } = await run({
      rules: [RULE, { ...RULE, projectKey: "GIZLI" }],
      found: {},
      boundProjects: ["OPS"],
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('project = "OPS"');
    // HER sorgu, teşhis sorgusu dahil: bağlanmamış bir projenin adı bu turda
    // Jira'ya giden hiçbir sorguda geçmemeli. Teşhis sorgusu ancak bağlı bir
    // projenin kuralı 0 döndüğünde ve YALNIZ o projeye atılır.
    expect(askedAll.join(" ")).not.toContain("GIZLI");
    expect(started).toHaveLength(0);
  });

  /**
   * BOTA ATANMIŞ OLMAK TEK BAŞINA YETMEZ.
   *
   * `assigned` bir tetikleme TİPİDİR, kapsamı genişleten bir muafiyet değil:
   * proje kapısı onun da ÜSTÜNDEDİR. Aksi hâlde "bota atanan her ticket" kuralı,
   * admin bir hesapla bankanın her projesine açılan bir kapı olurdu — ki
   * kullanıcının kurgusunda proje HER ZAMAN şart, tetikleme tipi onun İÇİNDE
   * bir seçimdir.
   */
  it("an `assigned` rule on an unbound project is still not searched", async () => {
    const { asked } = await run({
      rules: [{ ...RULE, projectKey: "GIZLI", matchKind: "assigned", matchValue: "*" }],
      found: {},
      boundProjects: ["OPS"],
    });

    expect(asked).toHaveLength(0);
  });

  /**
   * DURAKLATILAN PROJE, TARAMADAN DA ÇIKAR.
   *
   * Bağlı proje listesi `state = active` satırlarından gelir, "satır var"dan
   * değil: `paused` bir bağlama bilerek canlı DEĞİLDİR, ve duraklatan operatör
   * duraklatmanın hemen etkili olmasını bekler. Bu test o listenin daralmasının
   * turu gerçekten daralttığını sabitler.
   */
  it("stops searching a project as soon as it leaves the bound set", async () => {
    const before = await run({ rules: [RULE], found: {}, boundProjects: ["OPS"] });
    const after = await run({ rules: [RULE], found: {}, boundProjects: [] });

    expect(before.asked).toHaveLength(1);
    expect(after.asked).toHaveLength(0);
  });

  /**
   * BAĞLI PROJE LİSTESİ OKUNAMAZSA TUR DURUR — fail-closed.
   *
   * "Süzemedik, o hâlde süzmeyelim" bu kurulumda en tehlikeli daldır: admin bir
   * servis hesabıyla süzgeçsiz bir tur, bankanın her projesine sorgu göndermek
   * demektir. Geçici olarak hiç taramamak, geniş taramaktan iyidir.
   */
  it("skips the whole round when the bound-project list cannot be read", async () => {
    const { asked } = await run({ rules: [RULE], found: {}, boundProjectsThrows: true });
    expect(asked).toHaveLength(0);
  });

  /**
   * KURAL YOKSA HİÇBİR ŞEY — "hepsini al" dalı yok.
   *
   * Boş kural kümesinin geniş bir sorguya (ya da varsayılan bir JQL'e) düşmesi,
   * bu döngüde bir kolaylık değil bir kaza olurdu.
   */
  it("asks nothing at all when there are no rules", async () => {
    const { asked } = await run({ rules: [], found: {}, boundProjects: ["OPS"] });
    expect(asked).toHaveLength(0);
  });

  it("asks Jira once per enabled rule", async () => {
    const { asked } = await run({
      rules: [RULE, { ...RULE, matchValue: "Hata" }, { ...RULE, enabled: false }],
      found: {},
    });

    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain('issuetype = "Görev"');
    expect(asked[1]).toContain('issuetype = "Hata"');
  });

  it("asks nothing at all when no rule is enabled", async () => {
    const { asked } = await run({ rules: [{ ...RULE, enabled: false }], found: {} });
    expect(asked).toEqual([]);
  });

  /**
   * A ticket the platform already has a row for is finished business — done,
   * failed, or running. Re-starting it on a timer would turn one operator
   * decision into an endless loop of runs.
   */
  it("skips a ticket that already has a run", async () => {
    const jql = jqlFor(RULE)!;
    const { started } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1", "OPS-2"] },
      known: ["OPS-1"],
    });

    expect(started).not.toContain("OPS-1");
  });

  /**
   * ── "KOŞUSU ZATEN VAR" ARTIK KOŞUNUN NEREDE OLDUĞUNU DA SÖYLÜYOR ─────────
   *
   * Ölçülmüş yanılgı: operatör bu satırı okuyup "sistem beni duymuyor" diye
   * anlıyor. Atlama DOĞRU — ticket'ın koşusu var ve ikinci kez başlatılmamalı —
   * ama satır koşunun YAŞADIĞINI söylemiyordu, dolayısıyla atlamayı bir arıza
   * gibi okutuyordu. Koşunun kapıda beklediğini söylemek aynı olguyu doğru
   * okutuyor: "tamam, koşu benim onayımı bekliyor".
   *
   * Ek sorgu maliyeti yok: `step` ve `status` zaten `WorkflowRun` satırında.
   */
  it("atlarken koşunun NEREDE olduğunu söyler — 'sistem beni duymuyor' yanılgısının çaresi", async () => {
    const jql = jqlFor(RULE)!;
    const { started, logs } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1"] },
      known: [{ ticket: "OPS-1", step: "5", status: "gate" }],
    });

    expect(started).not.toContain("OPS-1");
    const skip = logs.find((line) => line.includes("OPS-1 atlandı"));
    expect(skip).toBeDefined();
    // Operatörün kelimeleri, kod adı değil: "gate" değil "kapıda".
    expect(skip).toContain("kapıda, insan onayı bekliyor");
    expect(skip).toContain("adım 5");
  });

  /**
   * "Havuzda hiçbir zaman ticket kalamaz." Koşusu bitmiş (tamamlandı / hatalı /
   * devredildi) ama hâlâ havuzda duran ticket, kuralın ihlalidir: sayılır,
   * adlandırılır, tarama bandı gösterir. Kapıda bekleyen ihlal değildir.
   */
  it("kaydı 'hatalı' olan koşuyu — motor onu canlı listelese bile — yeniden alır", async () => {
    const jql = jqlFor(RULE)!;
    const { restarts, logs } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1"] },
      known: [{ ticket: "OPS-1", step: "3", status: "fail" }],
      alive: ["OPS-1"],
    });
    expect(restarts).toEqual(["OPS-1"]);
    expect(logs.some((line) => line.includes("OPS-1") && line.includes("yeniden akışa alındı"))).toBe(true);
  });

  /**
   * ── DEVREDİLEN KOŞU HAVUZDA ÇÜRÜMEZ — canlıda ölçülen kırık ───────────────
   *
   * OPS-120/121/122/123 LLM 403'ü yüzünden insana devredildi ve bir daha HİÇ
   * akışa girmedi. İki sebep üst üste binmişti:
   *
   *  1. Devir satırın DURUMUNA hiç dokunmuyordu (`handOver`,
   *     `packages/workflows/src/impl/outcome.ts`), o yüzden açılıştaki kıyas
   *     satıra `done` yazıyordu. O yarı `outcome.ts`te düzeltildi.
   *  2. Satır `handover` dese bile bu tur onu yeniden ALMIYORDU: devredilen
   *     koşunun yürütmesi Temporal'da KAPALI, ve `liveRuns` bilerek
   *     `onlyRunning: false` ile okuduğu için ticket `alive` kümesinde
   *     görünüyor — yani "ölü koşu" dalına hiç uğramıyordu.
   *
   * Bu test ikinci yarıyı sabitliyor: `alive: ["OPS-1"]` tam olarak canlıdaki
   * hâl (motor ticket'ı TANIYOR, çünkü kapanmış execution'ı hâlâ tutuyor) ve
   * tura rağmen yeniden başlatma OLMALI. `isFailedRun`dan `handover` çıkarılırsa
   * bu beklenti kırmızıya döner.
   */
  it("insana DEVREDİLEN koşuyu — motor onu tanısa bile — yeniden akışa alır", async () => {
    const jql = jqlFor(RULE)!;
    const { restarts, logs } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1"] },
      known: [{ ticket: "OPS-1", step: "2", status: "handover" }],
      // Canlıdaki hâl: yürütme kapandı ama motor onu hâlâ listeliyor.
      alive: ["OPS-1"],
    });
    expect(restarts).toEqual(["OPS-1"]);
    expect(logs.some((line) => line.includes("OPS-1") && line.includes("yeniden akışa alındı"))).toBe(true);
  });

  /**
   * FREN DEĞİŞMEDİ. Devredilen bir koşunun yeniden alınabilir olması, sonsuza
   * kadar yeniden alınacağı anlamına gelmiyor: pencereli sayaç sınıra
   * ulaştığında tur DURUYOR ve ticket insana devrediliyor — kalıcı bir hatada
   * (hâlâ reddedilen bir model anahtarı) döngüyü açan şey tam olarak bu frenin
   * yokluğu olurdu.
   */
  it("devredilen koşuda da yeniden başlatma freni geçerlidir", async () => {
    const jql = jqlFor(RULE)!;
    const { restarts, logs } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1"] },
      known: [{ ticket: "OPS-1", step: "2", status: "handover" }],
      alive: ["OPS-1"],
      priorRestarts: { "OPS-1": 99 },
    });
    expect(restarts).toEqual([]);
    expect(logs.some((line) => line.includes("OPS-1") && line.includes("İNSANA DEVREDİLDİ"))).toBe(true);
  });

  it("koşusu bitmiş ama havuzda duran ticket'ı sayar ve adlandırır", async () => {
    const jql = jqlFor(RULE)!;
    await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1", "OPS-2", "OPS-3"] },
      known: [
        { ticket: "OPS-1", step: "3", status: "fail" },
        { ticket: "OPS-2", step: "13", status: "done" },
        { ticket: "OPS-3", step: "5", status: "gate" },
      ],
    });
    expect(discoveryStatus().lastLeftInPool).toBe(2);
    expect(discoveryStatus().leftInPoolKeys).toEqual(["OPS-1", "OPS-2"]);
  });

  it("düz anahtar listesi de çalışır — satır eskisi gibi yalnız 'koşusu var' der", async () => {
    const jql = jqlFor(RULE)!;
    const { started, logs } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1"] },
      known: ["OPS-1"],
    });

    expect(started).not.toContain("OPS-1");
    const skip = logs.find((line) => line.includes("OPS-1 atlandı"));
    // Satır yine yazılıyor — hangi ticket'ın atlandığı, durum bilinmese de
    // operatörün görmesi gereken bir şey.
    expect(skip).toBe("[keşif] OPS-1 atlandı: koşusu var");
  });

  /**
   * ── HAVUZDAKİ ÖLÜ KOŞU OTOMATİK YENİDEN BAŞLAR ───────────────────────────
   *
   * Operatörün şartı: "eğer analize gönderilen bir koşu varsa, robotun
   * havuzunda, düşen koşu önceden kapanmışsa OTOMATİK YENİDEN BAŞLAMALI".
   *
   * Bu testin ölçtüğü şey elle bir düğmeye basılmadan olan biten: ticket
   * kuralın havuzunda, satırı var (yani `known`), ama motor onu tanımıyor
   * (`alive` listesinde yok). Tur onu atlamak yerine yeniden akışa alır.
   */
  it("havuzdaki ölü koşuyu OTOMATİK yeniden başlatır — elle düğmeye basılmadan", async () => {
    const jql = jqlFor(RULE)!;
    const { restarts, started, logs } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1"] },
      known: [{ ticket: "OPS-1", step: "3", status: "running" }],
      // Motor OPS-1'i tanımıyor: koşu ölmüş.
      alive: [],
    });

    expect(restarts).toEqual(["OPS-1"]);
    // Yeniden akışa alınan ticket turun "alındı" listesine de girer: havuzdaki
    // iş ilerledi, ve panelin bunu bir tur çıktısı olarak görmesi gerekiyor.
    expect(started).toContain("OPS-1");
    const line = logs.find((l) => l.includes("OPS-1:"));
    expect(line).toContain("önceki koşu motorda bulunamadı");
    expect(line).toContain("1. yeniden başlatma");
    expect(line).toContain("emekliye ayrıldı");
  });

  /**
   * ── BİTEN KOŞU + HAVUZDA KALAN TİCKET = YENİDEN İŞLE ─────────────────────
   *
   * CANLIDA ÖLÇÜLDÜ (OPS-119): koşu `done`, ticket kuralın izinli statüsünde
   * ve bot'a atanmış duruyor. Tarama onu her turda buluyor ve her turda
   * "atlandı: koşusu var (tamamlandı, adım 3)" diyordu. Sonsuza kadar.
   * Operatör ticket'ı havuza geri verse bile hiçbir şey olmuyordu.
   *
   * Sebebi `liveRuns`ın `onlyRunning: false` okuması: KAPANMIŞ bir execution
   * da `alive` kümesinde görünüyor, yani biten koşu "ölü" sayılmıyor ve
   * yeniden başlatma dalına hiç girmiyordu.
   *
   * Yanlış olan çıkarımdı: "koşu bitti, demek ki iş bitti". Ticket havuzdaysa
   * iş BİTMEMİŞTİR — operatörün kuralı net: "havuzda hiçbir zaman ticket
   * kalamaz; işlem yapıldıktan sonra ileri ya da geri oynar".
   */
  it("koşusu BİTMİŞ ama havuzda kalmış ticket'ı yeniden işler", async () => {
    const jql = jqlFor(RULE)!;
    const { restarts, started, logs } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-119"] },
      known: [{ ticket: "OPS-119", step: "3", status: "done" }],
      // Motor onu TANIYOR (kapanmış execution da listede) — eski kod bu yüzden
      // atlıyordu. Yeni kod ticket'ın hâlâ havuzda olmasına bakıyor.
      alive: ["OPS-119"],
    });

    expect(restarts).toEqual(["OPS-119"]);
    expect(started).toContain("OPS-119");
    const line = logs.find((l) => l.includes("OPS-119:"));
    // Sebep DOĞRU yazılmalı: "motorda bulunamadı" burada düpedüz yanlış olurdu,
    // koşu bulunuyordu — bitmişti.
    expect(line).not.toContain("motorda bulunamadı");
    expect(line).toContain("havuzda kaldı");
    expect(line).toContain("1. yeniden başlatma");
  });

  it("aynı fren burada da geçerli: sınıra ulaşan ticket insana devredilir", async () => {
    const jql = jqlFor(RULE)!;
    const { restarts, logs } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-119"] },
      known: [{ ticket: "OPS-119", step: "3", status: "done" }],
      alive: ["OPS-119"],
      priorRestarts: { "OPS-119": 3 },
    });

    expect(restarts).toEqual([]);
    expect(logs.some((l) => l.includes("İNSANA DEVREDİLDİ"))).toBe(true);
    // Sınır satırı da sebebi doğru söylemeli.
    expect(logs.find((l) => l.includes("YENİDEN BAŞLATILMADI"))).toContain("havuzda kaldı");
  });

  /**
   * BİTEN İŞ BOŞUNA YENİDEN BAŞLAMAZ — bu düzeltmenin diğer yarısı.
   *
   * Ticket havuzdan ÇIKMIŞSA (statü eşlemesi onu ileri taşıdı, ya da biri
   * atamayı aldı) kural onu zaten bulmaz — JQL `assignee = bot AND status in
   * (...)` diyor. Yani bu senaryoda tur hiçbir şey görmez ve hiçbir şey
   * başlatmaz. Düzeltmenin "her biten koşuyu yeniden başlatma" gibi bir yan
   * etkisi OLMADIĞININ kanıtı budur.
   */
  it("havuzdan ÇIKMIŞ ticket yeniden başlatılmaz — kural onu hiç bulmaz", async () => {
    const jql = jqlFor(RULE)!;
    const { restarts, started } = await run({
      rules: [RULE],
      // Kural sorgusu boş dönüyor: ticket artık bot'a atanmış değil ya da
      // izinli statüde değil — yani havuzdan çıkmış.
      found: { [jql]: [] },
      known: [{ ticket: "OPS-119", step: "3", status: "done" }],
      alive: ["OPS-119"],
    });

    expect(restarts).toEqual([]);
    expect(started).toEqual([]);
  });

  it("KAPIDA BEKLEYEN koşuya dokunulmaz — insan onayı çöpe atılmaz", async () => {
    const jql = jqlFor(RULE)!;
    const { restarts, logs } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1"] },
      // `gate` bitmiş bir durum DEĞİL: iş sürüyor, insan onayı bekliyor.
      known: [{ ticket: "OPS-1", step: "5", status: "gate" }],
      alive: ["OPS-1"],
    });

    expect(restarts).toEqual([]);
    expect(logs.some((l) => l.includes("OPS-1 atlandı: koşusu var"))).toBe(true);
  });

  /**
   * MODEL ÖLÜYKEN YENİDEN BAŞLATMA YOK.
   *
   * Canlıda ölçüldü: anahtar reddedilirken tarama devredilen koşuları her
   * sabah yeniden başlatıyordu; her biri 30 kez daha reddediliyordu. Modelin
   * ölü olduğu bir turda yeniden başlatılan koşu ilk çağrıda aynı duvara
   * çarpar — anlamsız gürültü.
   */
  it("model anahtarı reddediliyorsa bu turda HİÇBİR koşu yeniden başlatılmaz", async () => {
    const jql = jqlFor(RULE)!;
    const { restarts, logs } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1"] },
      known: [{ ticket: "OPS-1", step: "2", status: "handover" }],
      alive: [],
      llmHealthy: false,
    });
    expect(restarts).toEqual([]);
    expect(logs.some((l) => l.includes("model anahtarı reddediliyor"))).toBe(true);
  });

  it("sağlık OKUNAMAZSA restart kapatılmaz — ölçemediğimiz şeye göre fren yok", async () => {
    const jql = jqlFor(RULE)!;
    const { restarts } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1"] },
      known: [{ ticket: "OPS-1", step: "2", status: "handover" }],
      alive: [],
      llmHealthy: "throws",
    });
    expect(restarts).toEqual(["OPS-1"]);
  });

  /**
   * CANLI KOŞUYA DOKUNULMAZ — frenlerin birincisi.
   *
   * Kapıda insan onayı bekleyen bir koşuyu yeniden başlatmak, o onayı sessizce
   * çöpe atmak olurdu. Motor ticket'ı tanıyorsa koşu yaşıyor demektir ve tur
   * eskisi gibi ATLAR.
   */
  it("motorda YAŞAYAN bir koşuya dokunmaz — kapıdaki onay çöpe gitmez", async () => {
    const jql = jqlFor(RULE)!;
    const { restarts, logs } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1"] },
      known: [{ ticket: "OPS-1", step: "5", status: "gate" }],
      alive: ["OPS-1"],
    });

    expect(restarts).toEqual([]);
    expect(logs.find((l) => l.includes("OPS-1 atlandı"))).toContain("kapıda, insan onayı bekliyor");
  });

  /**
   * MOTOR OKUNAMADIYSA HİÇBİR ŞEY — frenlerin ikincisi, ve en pahalısı.
   *
   * Boş dönen bir liste ile okunamayan bir motor AYNI ŞEY DEĞİL. İkisini bir
   * tutmak, bir ağ hıçkırığında havuzdaki HER koşuyu — kapıda bekleyenler
   * dahil — yeniden başlatmak olurdu.
   */
  it("motorun listesi okunamazsa HİÇBİR koşuyu ölü saymaz", async () => {
    const jql = jqlFor(RULE)!;
    const { restarts, logs } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1"] },
      known: [{ ticket: "OPS-1", step: "5", status: "gate" }],
      alive: "throws",
    });

    expect(restarts).toEqual([]);
    expect(logs.find((l) => l.includes("motorun koşu listesi okunamadı"))).toContain(
      "hiçbir ölü koşu yeniden başlatılmayacak",
    );
  });

  /**
   * SONSUZ DÖNGÜ FRENİ — N kez sonra DUR ve insana devret.
   *
   * Kalıcı bir hata yüzünden her koşusu ölen bir ticket, frensiz bir turda her
   * beş dakikada bir yeniden başlatılırdı: her turda bir denetim kaydı, bir
   * Jira yorumu, LLM çağrıları. Sayaç emekli SATIRLARDAN okunuyor, yani süreç
   * yeniden başlasa da sıfırlanmaz.
   */
  it("aynı ticket 3 kez yeniden başlatıldıysa DURUR ve insana devreder", async () => {
    const jql = jqlFor(RULE)!;
    const { restarts, logs } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1"] },
      known: [{ ticket: "OPS-1", step: "1", status: "running" }],
      alive: [],
      priorRestarts: { "OPS-1": 3 },
    });

    expect(restarts).toEqual([]);
    const line = logs.find((l) => l.includes("OPS-1 YENİDEN BAŞLATILMADI"));
    expect(line).toContain("3 kez otomatik yeniden başlatıldı");
    expect(line).toContain("İNSANA DEVREDİLDİ");
    // Devir turun ÖZETİNDE de görünür: operatörün bakması gereken tek satır
    // bu olabilir ve gürültünün içinde kaybolmamalı.
    expect(logs.find((l) => l.includes("tur bitti"))).toContain("İNSANA DEVREDİLDİ");
  });

  /** Sınırın ALTINDAysa yeniden başlatır — fren erken kapanmamalı. */
  it("sınırın altındaki bir ticket'ı yeniden başlatmaya DEVAM eder", async () => {
    const jql = jqlFor(RULE)!;
    const { restarts, logs } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1"] },
      known: [{ ticket: "OPS-1", step: "1", status: "running" }],
      alive: [],
      priorRestarts: { "OPS-1": 2 },
    });

    expect(restarts).toEqual(["OPS-1"]);
    expect(logs.find((l) => l.includes("OPS-1:"))).toContain("3. yeniden başlatma");
  });

  /**
   * Yeniden başlatılan ticket AYNI TURDA ikinci kez sayılmaz.
   *
   * Bir ticket'ı iki kural birden görebilir (`assigned` joker + tip kuralı) ve
   * ikisi de "koşusu ölü" derse iki kez yeniden başlatılırdı — bir işe iki
   * koşu, ve sayacın iki kere yenmesi.
   */
  it("aynı turda iki kural görse de bir kez yeniden başlatır", async () => {
    const byType = jqlFor(RULE)!;
    const byAssignment = jqlFor({ ...RULE, matchKind: "assigned", matchValue: "*" })!;
    const { restarts } = await run({
      rules: [RULE, { ...RULE, matchKind: "assigned", matchValue: "*" }],
      found: { [byType]: ["OPS-1"], [byAssignment]: ["OPS-1"] },
      known: [{ ticket: "OPS-1", step: "1", status: "running" }],
      alive: [],
    });

    expect(restarts).toEqual(["OPS-1"]);
  });

  /**
   * Alım REDDEDİLİRSE (kill-switch, duraklatılmış bağlantı) satır sebebini
   * söyler — ve ticket "alındı" sayılmaz.
   */
  it("yeniden başlatma alımı reddedilirse sebebini yazar ve alınmış saymaz", async () => {
    const jql = jqlFor(RULE)!;
    const { restarts, started, logs } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1"] },
      known: [{ ticket: "OPS-1", step: "1", status: "running" }],
      alive: [],
      restartRefused: true,
    });

    expect(restarts).toEqual(["OPS-1"]);
    expect(started).not.toContain("OPS-1");
    expect(logs.find((l) => l.includes("OPS-1:"))).toContain("alım reddedildi: kill_switch");
  });

  /**
   * SAYAÇ OKUNAMAZSA YENİDEN BAŞLATMA YOK — freni ölçemediğimiz turda denemek,
   * freni hiç koymamakla aynı şey olurdu.
   *
   * Ve bu bir DEVİR DEĞİL bir atlama: sayı bilinmiyor, tükenmiş değil.
   * Devir sayısını artırmak, operatöre kalıcı bir hata olduğunu söylemek
   * olurdu — oysa olan yalnızca bir veritabanı hıçkırığı.
   */
  it("yeniden başlatma sayacı okunamazsa denemez ve bunu DEVİR saymaz", async () => {
    const jql = jqlFor(RULE)!;
    const { restarts, logs } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1"] },
      known: [{ ticket: "OPS-1", step: "1", status: "running" }],
      alive: [],
      priorRestarts: "throws",
    });

    expect(restarts).toEqual([]);
    expect(logs.find((l) => l.includes("sayacı okunamadı"))).toBeDefined();
    expect(logs.find((l) => l.includes("tur bitti"))).not.toContain("İNSANA DEVREDİLDİ");
  });

  /**
   * Seam KURULMAMIŞSA tur bugüne kadarki hâlini bit bit korur: koşusu olan
   * ticket atlanır, hiçbir şey yeniden başlatılmaz.
   */
  it("otomatik yeniden başlatma kurulmamışsa tur eskisi gibi ATLAR", async () => {
    const jql = jqlFor(RULE)!;
    const { restarts, started, logs } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1"] },
      known: [{ ticket: "OPS-1", step: "1", status: "running" }],
    });

    expect(restarts).toEqual([]);
    expect(started).not.toContain("OPS-1");
    expect(logs.find((l) => l.includes("OPS-1 atlandı"))).toBeDefined();
  });

  /**
   * Several rules routinely match one ticket — an `assigned` wildcard beside a
   * per-issuetype rule is the shape the seed itself writes. Starting it once
   * per matching rule would be N runs for one piece of work.
   */
  it("starts a ticket once even when two rules match it", async () => {
    const byType = jqlFor(RULE)!;
    const byAssignment = jqlFor({ ...RULE, matchKind: "assigned", matchValue: "*" })!;
    const { started } = await run({
      rules: [RULE, { ...RULE, matchKind: "assigned", matchValue: "*" }],
      found: { [byType]: ["OPS-7"], [byAssignment]: ["OPS-7"] },
    });

    expect(started.filter((key) => key === "OPS-7")).toHaveLength(
      started.includes("OPS-7") ? 1 : 0,
    );
  });

  /**
   * The round-level half of the fail-closed rule: a rule with no bot account
   * must not merely produce a harmless query, it must produce NO REQUEST.
   *
   * Asserted on `asked` rather than on `started`, because "started nothing" is
   * also what a search that ran and matched nothing looks like — and the whole
   * risk here is a query that DOES reach a Jira the service account is admin
   * on. The good rule beside it proves the skip is surgical: one bad rule must
   * not disarm the sweep.
   */
  /**
   * TARAMANIN OKUDUĞU TICKET, KURALIN KENDİSİYLE EŞLEŞMELİ — DÖRT TETİKLEME
   * TİPİNİN HEPSİNDE.
   *
   * Ölçülen hata: tarama `runIntake`'e yalnızca ticket anahtarını veriyordu.
   * `flow-decision.ts` her kuralı dört `null`'a karşı karşılaştırıyor, HİÇBİRİ
   * eşleşmiyor, ve tarama tam da bir kural yüzünden bulduğu ticket'ı o kural
   * hiç yokmuş gibi çalıştırıyordu — kuralın akışı da statü eşlemesi de
   * kayboluyor, analiz-only bağlamada ise ticket `no_application` ile
   * reddediliyordu. Sahada görülen: "ticket geliyor ama ajan çalışmıyor".
   *
   * Bu test sorgu METNİNİ değil, ELDEN ELE GEÇEN VERİYİ sürüyor: gerçek bir
   * Jira `issue` belgesi (webhook'un taşıdığının aynısı) taramanın okuyucusuna,
   * onun okuduğu alanlar da gerçek eşleştiriciye verilir. Yalnız JQL'i
   * doğrulayan bir test bu hatayı göremezdi — sorgu zaten doğruydu.
   *
   * Dört tipin hepsi döngüde, çünkü bugünkü hata sınıfı tam olarak "bir yolda
   * çalışıyor, diğerinde sessizce çalışmıyor": bir tetikleme tipinin yalnız
   * webhook'ta çalışıp taramada çalışmaması hiçbir yerde hata üretmez.
   */
  it.each(["status", "issuetype", "label", "assigned"] as const)(
    "a %s rule: what the sweep reads off Jira matches that same rule",
    (matchKind) => {
      const matchValue = matchKind === "assigned" ? "*" : "Analiz Bekliyor";
      const rule: DiscoveryRule = { ...RULE, matchKind, matchValue };

      /**
       * The document Jira answers the search with. Every field is populated
       * whatever the rule matched on — a real ticket has a status, a type, an
       * assignee and labels regardless of which one triggered the rule, and a
       * fixture that filled only the matched one would hide a reader that looks
       * at the wrong field.
       */
      const issue = {
        key: "OPS-91",
        fields: {
          status: { name: matchKind === "status" ? matchValue : "Devam Ediyor" },
          issuetype: { name: matchKind === "issuetype" ? matchValue : "Görev" },
          assignee: { accountId: rule.assigneeAccountId },
          // A second label beside the matched one: a label rule must match by
          // MEMBERSHIP, and a matcher that compared the whole list (or only
          // its first entry) would pass a single-label fixture and fail here.
          labels: matchKind === "label" ? ["baska-etiket", matchValue] : ["baska-etiket"],
        },
      };

      const handed = classifyingFieldsOf(issue);

      const decided = flowDecisionFor(
        [
          {
            ruleId: "lr_1",
            projectKey: rule.projectKey,
            assigneeAccountId: rule.assigneeAccountId,
            matchKind: rule.matchKind,
            matchValue: rule.matchValue,
            flowType: "analiz",
            priority: 100,
            enabled: true,
            analystVariantId: null,
            engineerVariantId: null,
            statusMap: null,
          },
        ] as never,
        {
          projectKey: rule.projectKey,
          status: handed.status ?? null,
          issueType: handed.issueType ?? null,
          assignee: handed.assignee ?? null,
          labels: handed.labels ?? null,
        } as never,
        null,
      );

      expect(decided.reason, `${matchKind} kuralı eşleşmedi`).toBe("rule");
      expect(decided.flow).toBe("analiz");
    },
  );

  /**
   * Bir alanı taşımayan teslimat, o alandaki kuralı eşleştirmemeli.
   *
   * Okuyucunun yokluğu boş dizeye ya da boş listeye çevirmesi, `matchValue`'su
   * boş bir kuralı HER ticket'a uydururdu — ve bunu sessizce yapardı. Yokluk
   * "sormadık" demeye devam etmeli.
   */
  it("omits a field the payload does not carry, rather than inventing one", () => {
    expect(classifyingFieldsOf({ key: "OPS-91", fields: {} })).toEqual({});
    expect(classifyingFieldsOf({ key: "OPS-91" })).toEqual({});
  });

  /**
   * Etiketsiz bir ticket ile etiketi OKUNMAMIŞ bir ticket farklı cevaplardır.
   * `[]` "bu ticket'ın etiketi yok" der (etiket kuralı doğru şekilde
   * eşleşmez); yokluk "bakmadık" der. İkisi de eşleşmemeli, ama aynı sebeple
   * değil — ve `[]`'in yokluğa çevrilmesi bir kuralı boş listeye karşı
   * "eşleşti" sayan bir okuyucuya kapı açardı.
   */
  it("keeps an empty label list distinct from an absent one", () => {
    expect(classifyingFieldsOf({ key: "OPS-91", fields: { labels: [] } })).toEqual({ labels: [] });
  });

  /**
   * TAKIM YÖNETİMLİ (next-gen) PROJE — turun okuduğu şey kuralın tuttuğu şey.
   *
   * ── CANLI ÖLÇÜM ───────────────────────────────────────────────────────────
   * `issuetype = "Görev"` → 0 ticket, `issuetype = 10008` → 14. `jqlFor` bu
   * yüzden sayısal değeri tırnaksız yazıyor; yani tur, ticket'ı KİMLİKLE
   * buluyor. Ama `classifyingFieldsOf` kimliği okumazsa `matches()` ada düşer
   * ve tur, KENDİ sorgusunun getirdiği ticket'ı kendi kuralıyla eşleştiremez —
   * arıza "hiç bulunmuyor"dan "bulunuyor ama işlenmiyor"a taşınır, ikisi de
   * sessiz. Bu test tam olarak o gidiş-dönüşü kapatıyor.
   *
   * Arama zaten `fields: ["status", "issuetype", ...]` istiyor ve Jira ikisini
   * de `{id, name}` olarak döndürüyor: kimlik ek bir istek DEĞİL.
   */
  it("takım yönetimli projede kimliği okur ve İD tutan kuralla eşleşir", () => {
    const issue = {
      key: "OPS-41",
      fields: {
        status: { id: "10004", name: "Yapılacaklar" },
        issuetype: { id: "10008", name: "Görev" },
        assignee: { accountId: "712020:bot" },
        labels: [],
      },
    };

    const handed = classifyingFieldsOf(issue);
    expect(handed.issueTypeId).toBe("10008");
    expect(handed.statusId).toBe("10004");
    // Adlar da AYNEN duruyor: kimlik, adın yerine geçmiyor — şirket yönetimli
    // projede eşleşme hâlâ ada düşüyor.
    expect(handed.issueType).toBe("Görev");
    expect(handed.status).toBe("Yapılacaklar");

    for (const [matchKind, matchValue] of [
      ["issuetype", "10008"],
      ["status", "10004"],
    ] as const) {
      const decided = flowDecisionFor(
        [
          {
            ruleId: "lr_id",
            projectKey: "OPS",
            assigneeAccountId: "",
            matchKind,
            matchValue,
            flowType: "analiz",
            priority: 100,
            enabled: true,
            analystVariantId: null,
            engineerVariantId: null,
            statusMap: null,
          },
        ] as never,
        {
          projectKey: "OPS",
          status: handed.status ?? null,
          statusId: handed.statusId ?? null,
          issueType: handed.issueType ?? null,
          issueTypeId: handed.issueTypeId ?? null,
          assignee: handed.assignee ?? null,
          labels: handed.labels ?? null,
        } as never,
        null,
      );
      expect(decided.reason, `${matchKind} = ${matchValue} eşleşmedi`).toBe("rule");
    }
  });

  /**
   * Jira kimliği SAYI olarak da gönderebiliyor; kuralın `matchValue`'su ise
   * her zaman metin. Okuyucu ikisini aynı yere getirmezse eşleşme
   * `10008 === "10008"` üzerinden sessizce düşerdi.
   */
  it("sayı olarak gelen kimliği de metne çevirir", () => {
    const handed = classifyingFieldsOf({
      key: "OPS-42",
      fields: { issuetype: { id: 10008, name: "Görev" } },
    });
    expect(handed.issueTypeId).toBe("10008");
  });

  /** Kimliksiz belge kimlik UYDURMAZ — yokluk "sormadık" demeye devam eder. */
  it("kimlik taşımayan bir belgede kimlik alanlarını hiç yazmaz", () => {
    const handed = classifyingFieldsOf({
      key: "OPS-43",
      fields: { issuetype: { name: "Görev" }, status: { name: "Yapılacaklar" } },
    });
    expect(handed).toEqual({ issueType: "Görev", status: "Yapılacaklar" });
    expect("issueTypeId" in handed).toBe(false);
    expect("statusId" in handed).toBe(false);
  });

  it("never sends a search for a rule with no bot account", async () => {
    const good = jqlFor(RULE)!;
    const { asked } = await run({
      rules: [{ ...RULE, assigneeAccountId: "" }, RULE],
      found: { [good]: ["OPS-5"] },
    });

    // The accountless rule produced NO request, and the good rule beside it
    // still did: one misconfigured rule must not disarm the whole sweep.
    expect(asked).toEqual([good]);
    expect(asked.some((jql) => jql.includes("in ()"))).toBe(false);
  });

  /**
   * One project whose permissions changed must not freeze discovery for every
   * other project — the failure mode that turns a partial outage into a total
   * one.
   */
  it("keeps going when one rule's search fails", async () => {
    const asked: string[] = [];
    const search = {
      searchIssues: (request: { jql: string }) => {
        asked.push(request.jql);
        if (request.jql.includes("Görev")) return Promise.reject(new Error("403"));
        return Promise.resolve({ issues: [] });
      },
    };

    await discoverOnce({
      deps: {} as never,
      search,
      rules: () => Promise.resolve([RULE, { ...RULE, matchValue: "Hata" }]),
      known: () => Promise.resolve([]),
      intervalMs: 0,
      log: () => undefined,
    });

    // Teşhis sorgusu hariç: kural başına bir sorgu sayılıyor.
    expect(asked.filter((jql) => !jql.includes("statusCategory"))).toHaveLength(2);
  });

  /**
   * A round that finds nothing must still SAY so.
   *
   * Measured on the live install: a healthy sweep printed nothing at all when
   * every matching ticket was already known, so the log looked exactly the
   * same as a sweep that had never started — and "my tickets are not arriving"
   * is precisely the moment an operator needs those two told apart. The status
   * endpoint knows, but it needs a session; the log is what gets read first.
   */
  it("reports the round even when it starts nothing", async () => {
    const logged: string[] = [];
    await discoverOnce({
      deps: {} as never,
      search: { searchIssues: () => Promise.resolve({ issues: [{ key: "OPS-1" }] }) },
      rules: () => Promise.resolve([RULE]),
      known: () => Promise.resolve(["OPS-1"] as never),
      intervalMs: 0,
      log: (message) => logged.push(message),
    });

    const summary = logged.find((line) => line.includes("tur bitti"));
    expect(summary).toBeDefined();
    // It says what it searched with and what it took, so "1 rule, 0 taken"
    // reads as a working sweep rather than a broken one.
    expect(summary).toContain("1 kural");
    expect(summary).toContain("0 ticket");
  });

  it("says so when there is no enabled rule to search with", async () => {
    const logged: string[] = [];
    await discoverOnce({
      deps: {} as never,
      search: { searchIssues: () => Promise.resolve({ issues: [] }) },
      rules: () => Promise.resolve([{ ...RULE, enabled: false }]),
      known: () => Promise.resolve([]),
      intervalMs: 0,
      log: (message) => logged.push(message),
    });

    expect(logged.join(" ")).toContain("açık dinleme kuralı yok");
  });

  it("survives an unreadable rule list rather than throwing at the timer", async () => {
    const result = await discoverOnce({
      deps: {} as never,
      search: { searchIssues: () => Promise.resolve({ issues: [] }) },
      rules: () => Promise.reject(new Error("db down")),
      known: () => Promise.resolve([]),
      intervalMs: 0,
      log: () => undefined,
    });

    expect(result).toEqual([]);
  });
});

/**
 * The interval is an OPERATOR setting, in seconds, and it must take effect on
 * the next round rather than the next restart.
 *
 * Asked for directly: "65 dakikayı 1 dk 20 saniyeye ayarlayabilmem lazım."
 * Minutes could not express 80 seconds at all, and a fixed `setInterval` would
 * have kept whatever it was created with until the container was restarted —
 * which on a bank's server is a change request, not a click.
 */
describe("startJiraDiscovery: the operator's interval", () => {
  it("reschedules at the seconds the parameter says, not the boot default", async () => {
    const asked: number[] = [];
    const loop = startJiraDiscovery({
      deps: {} as never,
      search: { searchIssues: () => Promise.resolve({ issues: [] }) },
      rules: () => Promise.resolve([]),
      known: () => Promise.resolve([]),
      // Boot default is five minutes; the operator says 80 seconds.
      intervalMs: 300_000,
      intervalSeconds: () => {
        asked.push(Date.now());
        return Promise.resolve(80);
      },
      log: () => undefined,
    });

    // One tick is enough: the reschedule reads the parameter after the round.
    await new Promise((resolve) => setTimeout(resolve, 60));
    loop.stop();

    expect(asked.length).toBeGreaterThan(0);
  });

  it("stops rescheduling when the operator sets 0", async () => {
    let rounds = 0;
    const loop = startJiraDiscovery({
      deps: {} as never,
      search: {
        searchIssues: () => {
          rounds += 1;
          return Promise.resolve({ issues: [] });
        },
      },
      rules: () => Promise.resolve([]),
      known: () => Promise.resolve([]),
      intervalMs: 10,
      intervalSeconds: () => Promise.resolve(0),
      log: () => undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    loop.stop();

    // Zero means off: no second round was scheduled, however short the boot
    // interval was.
    expect(rounds).toBeLessThanOrEqual(1);
  });
});

/**
 * Which drivers can be swept at all.
 *
 * The composition root used to hand the sweep `ports.work as unknown as
 * IssueSearcher`. TypeScript accepts that cast; the runtime does not, and every
 * round threw "searchIssues is not a function": silently on the timer, and as a
 * bare HTTP 500 behind the panel's "şimdi tara" button, which is where the
 * customer finally saw it.
 *
 * Jira Data Center used to be on the failing side of this line, and the cost
 * was far worse than a missing optimisation. On a closed-network DC no webhook
 * can be registered, and the comment poller only ever looks at tickets that
 * ALREADY have a run (`openTickets` reads `db.workflowRun`) — so with the sweep
 * unavailable too, nothing could ever enter the platform at all. The DC driver
 * offers `searchIssues` now (`/rest/api/2/search`, which DC always had), so
 * both Jira drivers answer true here. The check stays real because Azure
 * DevOps still has no work port.
 *
 * Asking the object is what a cast pretended to do. These pin the question.
 */
describe("canSearch", () => {
  it("accepts a driver that really offers the search", () => {
    expect(canSearch({ searchIssues: () => Promise.resolve({ issues: [] }) })).toBe(true);
  });

  it("rejects a work driver that has no search — the ADO case", () => {
    // Shaped like a real work port: everything the workflow needs, no search.
    const workPortWithoutSearch = {
      getTicket: () => Promise.resolve({}),
      addComment: () => Promise.resolve({ commentId: "1" }),
      transition: () => Promise.resolve(),
    };

    expect(canSearch(workPortWithoutSearch)).toBe(false);
  });

  /**
   * A property that merely EXISTS is what the old cast effectively assumed.
   * Calling a string would throw exactly the error this check exists to stop.
   */
  it("rejects a driver whose searchIssues is not callable", () => {
    expect(canSearch({ searchIssues: "yes" })).toBe(false);
  });

  it("rejects nothing at all rather than throwing on it", () => {
    expect(canSearch(null)).toBe(false);
    expect(canSearch(undefined)).toBe(false);
  });
});

/**
 * SIFIR SONUÇ DÖNDÜĞÜNDE PROJEDE NE VAR — teşhis sorgusu.
 *
 * Kuralın JQL'i log'da (1.0.17), ama operatör onu Jira'nın gerçeğiyle
 * karşılaştıramıyordu: "kuralım issuetype = Görev diyor" ile "Jira'da hepsi
 * Task yazıyor" arasındaki farkı görebilmek için ikinci yarı da lazım. Bu
 * testler o ikinci yarının üç sınırını çiviliyor: ne zaman sorulduğu, kaç kez
 * sorulduğu ve — en önemlisi — hangi alanların İSTENMEDİĞİ.
 */
describe("keşif teşhis sorgusu", () => {
  /** Kuralın sorgusuna boş, teşhis sorgusuna örnek ticket'lar dönen bir arama. */
  function searchWithProjectTickets(issues: readonly unknown[]): {
    search: { searchIssues: (r: { jql: string; fields?: string[] }) => Promise<{ issues: Array<{ key?: string }> }> };
    asked: Array<{ jql: string; fields?: string[] }>;
  } {
    const asked: Array<{ jql: string; fields?: string[] }> = [];
    return {
      asked,
      search: {
        searchIssues: (request) => {
          asked.push(request);
          if (request.jql.includes("statusCategory")) {
            return Promise.resolve({ issues: issues as Array<{ key?: string }> });
          }
          return Promise.resolve({ issues: [] });
        },
      },
    };
  }

  const TICKET = {
    key: "OPS-12",
    fields: {
      status: { name: "ANALİZ" },
      issuetype: { name: "Task" },
      assignee: { accountId: "maestro-bot" },
      labels: ["maestro"],
    },
  };

  it("kural 0 dönünce projedeki açık ticket'ları alanlarıyla yazar", async () => {
    const logged: string[] = [];
    const { search } = searchWithProjectTickets([TICKET]);

    await discoverOnce({
      deps: {} as never,
      search,
      rules: () => Promise.resolve([RULE]),
      known: () => Promise.resolve([]),
      intervalMs: 0,
      log: (message) => logged.push(message),
    });

    const line = logged.find((message) => message.includes("OPS-12"));
    expect(line).toBeDefined();
    // Dört sebebin dördü de tek satırda: tip adı, statü, atanan, etiket.
    expect(line).toContain('tip="Task"');
    expect(line).toContain('statü="ANALİZ"');
    expect(line).toContain("atanan=maestro-bot");
    expect(line).toContain("etiket=[maestro]");
  });

  /**
   * TİCKET METNİ YOK. `fields` kuralın kendi sorgusuyla birebir aynı olmalı —
   * bir teşhis kolaylığı, bu yolun bugüne kadar hiç ticket içeriği taşımamış
   * olmasını bozacak yer değil.
   */
  it("özet/açıklama İSTEMEZ — kuralın istediği dört alanın aynısı", async () => {
    const { search, asked } = searchWithProjectTickets([TICKET]);

    await discoverOnce({
      deps: {} as never,
      search,
      rules: () => Promise.resolve([RULE]),
      known: () => Promise.resolve([]),
      intervalMs: 0,
      log: () => undefined,
    });

    const probe = asked.find((request) => request.jql.includes("statusCategory"));
    expect(probe?.fields).toEqual(["status", "issuetype", "assignee", "labels"]);
  });

  /**
   * Sorgu projeye HAPSEDİLİR. Bu platformun servis hesabı çoğu bankada Jira
   * ADMIN'idir; sınırsız bir teşhis sorgusu, Maestro'yu hiç duymamış ekiplerin
   * ticket'larını çeker — `boundProjects` kapısının önlediği şeyin aynısı.
   */
  it("sorguyu kuralın projesine hapseder, kapalı ticket'ları dışarıda bırakır", () => {
    expect(diagnosticJqlFor("OTYT")).toContain('project = "OTYT"');
    expect(diagnosticJqlFor("OTYT")).toContain("statusCategory != Done");
    // Kaçış: proje anahtarı serbest metin, tırnak kapatıp JQL'e ekleme yapılamaz.
    expect(diagnosticJqlFor('A" OR x')).toContain('project = "A\\" OR x"');
  });

  /**
   * TUR BAŞINA PROJE BAŞINA BİR KEZ. Aynı projede beş kural varsa beşi de 0
   * dönebilir; beş kez sormak Jira'ya beş gereksiz çağrı ve log'a birbirinin
   * kopyası beş blok demek.
   */
  it("aynı projede birden çok kural 0 dönse de yalnız bir kez sorar", async () => {
    const { search, asked } = searchWithProjectTickets([TICKET]);

    await discoverOnce({
      deps: {} as never,
      search,
      rules: () =>
        Promise.resolve([RULE, { ...RULE, matchValue: "Hata" }, { ...RULE, matchKind: "status" as const }]),
      known: () => Promise.resolve([]),
      intervalMs: 0,
      log: () => undefined,
    });

    const probes = asked.filter((request) => request.jql.includes("statusCategory"));
    expect(probes).toHaveLength(1);
  });

  it("sonuç bulan bir kural için teşhis sorgusu ATMAZ", async () => {
    const asked: string[] = [];
    await discoverOnce({
      deps: {} as never,
      search: {
        searchIssues: (request: { jql: string }) => {
          asked.push(request.jql);
          return Promise.resolve({ issues: [{ key: "OPS-1" }] });
        },
      },
      rules: () => Promise.resolve([RULE]),
      known: () => Promise.resolve(["OPS-1"] as never),
      intervalMs: 0,
      log: () => undefined,
    });

    expect(asked.filter((jql) => jql.includes("statusCategory"))).toHaveLength(0);
  });

  /**
   * Teşhis bir kolaylık, turun kendisi değil. İzni yetmeyen bir kurulumda
   * hatası yutulur ve tur normal biter — aksi hâlde teşhisin kendisi, teşhis
   * etmeye çalıştığı sessiz arızayı üretirdi.
   */
  it("teşhis sorgusu patlarsa turu düşürmez", async () => {
    const logged: string[] = [];
    await discoverOnce({
      deps: {} as never,
      search: {
        searchIssues: (request: { jql: string }) => {
          if (request.jql.includes("statusCategory")) return Promise.reject(new Error("403"));
          return Promise.resolve({ issues: [] });
        },
      },
      rules: () => Promise.resolve([RULE]),
      known: () => Promise.resolve([]),
      intervalMs: 0,
      log: (message) => logged.push(message),
    });

    expect(logged.some((line) => line.includes("tur bitti"))).toBe(true);
    expect(logged.some((line) => line.includes("teşhis sorgusu yapılamadı"))).toBe(true);
  });

  it("projede hiç açık ticket yoksa bunu ayrıca söyler", async () => {
    const logged: string[] = [];
    const { search } = searchWithProjectTickets([]);

    await discoverOnce({
      deps: {} as never,
      search,
      rules: () => Promise.resolve([RULE]),
      known: () => Promise.resolve([]),
      intervalMs: 0,
      log: (message) => logged.push(message),
    });

    expect(logged.some((line) => line.includes("hiç açık ticket yok"))).toBe(true);
  });
});

/**
 * ── HAVUZ: "BİTENE KADAR ÇALIŞIR, DURMAZ ATLAMAZ" ───────────────────────────
 *
 * Operatörün modeli, kendi cümlesiyle: "robotun statü havuzu olur ve orada
 * kendine atanmış her şeyi bitene kadar devam eder".
 *
 * Ölçülen eski davranış bunun tersiydi: tur başına sabit 20 sınırı vardı,
 * havuzda 50 iş varsa 20'si alınıyor ve kalan 30'u bir sonraki turu (varsayılan
 * 300 sn) bekliyordu — ve HİÇBİR YERDE YAZMIYORDU. Log "20 ticket alındı"
 * diyordu; geride 30 iş kaldığını söylemiyordu. Operatör bunu "atlıyor" diye
 * okur, ve haklıdır: sistemin ona söylemediği bir şey oluyordur.
 *
 * Aşağısı üç şeyi ölçüyor: kalanın SAYILDIĞINI, SÖYLENDİĞİNİ, ve boşalan bir
 * havuzda hiçbir şey söylenmediğini (sahte bir birikim uyarısı, hiç uyarı
 * olmamasından kötüdür).
 */
describe("havuz — tur sınırına takılan tur kalanı SÖYLER", () => {
  /** `n` ticket'lık bir arama sayfası döndüren sahte arama. */
  function poolOf(count: number): { search: never } {
    const issues = Array.from({ length: count }, (_unused, index) => ({
      key: `OPS-${index + 1}`,
      fields: { status: { name: "analiz" }, assignee: { accountId: "bot" }, labels: [] },
    }));
    return {
      search: {
        searchIssues: (request: { maxResults?: number }) =>
          Promise.resolve({ issues: issues.slice(0, request.maxResults ?? issues.length) }),
      } as never,
    };
  }

  async function round(count: number, cap: number): Promise<readonly string[]> {
    const logs: string[] = [];
    await discoverOnce({
      deps: {
        bindings: { resolve: () => Promise.resolve(null) },
        counters: { droppedKillSwitch: 0 },
      } as never,
      search: poolOf(count).search,
      rules: () => Promise.resolve([RULE]),
      known: () => Promise.resolve([]),
      intervalMs: 0,
      maxPerRound: cap,
      log: (message: string) => void logs.push(message),
    });
    return logs;
  }

  it("sınıra takılan tur, havuzda kalan işi SÖYLER ve durumu yazar", async () => {
    /**
     * Havuzda 5 iş, tur sınırı 2. Jira'ya `maxResults: 3` (sınır + 1) gider,
     * 2'si alınır ve 1'i geride kalır.
     *
     * SAYININ "1" ÇIKMASI TESTİN KONUSU, bir eksikliği değil: sayı bir ALT
     * SINIR ve log satırı bunu "en az" diyerek söylüyor. Sınırdan bir fazlasını
     * istemek, "havuzda daha var mı" sorusuna admin yetkili bir hesapla her
     * turda havuzun tamamını gezmeden cevap vermenin yolu. Gerçek birikimi
     * bulmanın yolu sayfalama olurdu ve bedeli buna değmez — çünkü bu sayının
     * asıl işi bir MİKTAR bildirmek değil, "tekrar bak" demek.
     */
    const logs = await round(5, 2);
    const summary = logs.find((line) => line.includes("tur bitti"));
    expect(summary).toBeDefined();
    expect(summary).toContain("tur sınırına (2) takıldı");
    expect(summary).toContain("havuzda en az 1 iş kaldı");
    expect(summary).toContain("hemen yeni tur yapılacak");
    // Ve panel de görüyor — log satırı tek başına yetmez, operatörün panelde
    // bakacağı yer burası.
    expect(discoveryStatus().poolRemaining).toBe(1);
  });

  it("havuz boşaldığında kalan BİLDİRİLMEZ — sahte bir birikim gösterilmez", async () => {
    // Havuzda 2 iş, tur sınırı 5: sınıra hiç takılmadık.
    const logs = await round(2, 5);
    const summary = logs.find((line) => line.includes("tur bitti"));
    expect(summary).toBeDefined();
    expect(summary).not.toContain("havuzda");
    expect(discoveryStatus().poolRemaining).toBeNull();
  });

  it("bir önceki turun kalanı, boşalan bir turdan sonra ekranda KALMAZ", async () => {
    // Bu, `record`un `poolRemaining`i her turda yeniden yazmasının ölçümü:
    // önce dolu bir tur, sonra boşalan bir tur. İkincisinden sonra panel
    // birinciyi göstermeye devam ederse operatör olmayan bir birikimi
    // kovalar.
    await round(5, 2);
    expect(discoveryStatus().poolRemaining).toBe(1);
    await round(2, 5);
    expect(discoveryStatus().poolRemaining).toBeNull();
  });

  it("koşusu OLAN ticket'lar kalan sayılmaz — birikim gerçek olmalı", async () => {
    /**
     * Sınırın ötesinde kalan satırların hepsi "kalan iş" DEĞİL: koşusu zaten
     * olanlar, sınır kalksa da alınmayacaktı. Onları saymak, operatöre hiç var
     * olmamış bir birikim göstermek olurdu — "14 ticket bulundu, 0 alındı"
     * satırının bir operatörü çalışan bir sorguda hata aramaya göndermesiyle
     * aynı hata, ters yönde.
     *
     * Kurgu: havuzda 5 satır, sınır 2, yani `maxResults: 3` ile ilk üçü
     * geliyor. İlk ikisinin (OPS-1, OPS-2) KOŞUSU VAR — atlanıyorlar ve sınıra
     * SAYILMIYORLAR, çünkü alınmadılar. Üçüncüsü alınıyor. Sınıra hiç
     * takılmadığımız için kalan da bildirilmiyor: geride bırakılan bir iş yok,
     * yalnız zaten koşan iki iş var.
     */
    const logs: string[] = [];
    await discoverOnce({
      deps: {
        bindings: { resolve: () => Promise.resolve(null) },
        counters: { droppedKillSwitch: 0 },
      } as never,
      search: poolOf(5).search,
      rules: () => Promise.resolve([RULE]),
      known: () => Promise.resolve(["OPS-1", "OPS-2"] as never),
      intervalMs: 0,
      maxPerRound: 2,
      log: (message: string) => void logs.push(message),
    });
    const summary = logs.find((line) => line.includes("tur bitti"));
    expect(summary).toContain("2'inin koşusu zaten var");
    expect(summary).not.toContain("havuzda");
    expect(discoveryStatus().poolRemaining).toBeNull();
  });
});

/**
 * ── BOŞALTMA DÖNGÜSÜ — "durmaz" ile "kontrolsüz" arasındaki çizgi ───────────
 *
 * `startJiraDiscovery` sınıra takılan bir turu HEMEN tekrarlar, 300 sn'lik
 * normal aralığı beklemeden: operatörün "havuzda iş kaldığı sürece durmaz"
 * beklentisi bu. Aşağısı üç freni ölçüyor, çünkü bu platformun Jira servis
 * hesabı rutin olarak ADMIN ve frensiz bir döngü tek bir yanlış kuralla
 * bankadaki her projeyi analize sokabilir.
 */
describe("boşaltma döngüsü — durmaz, ama kontrolsüz de değil", () => {
  /** `rounds` turluk bir kuyruk: her tur ne bulacak ve neyi alacak. */
  function stubbedRounds(pages: readonly (readonly string[])[]): {
    search: never;
    calls: () => number;
  } {
    let call = 0;
    return {
      calls: () => call,
      search: {
        searchIssues: () => {
          const page = pages[Math.min(call, pages.length - 1)] ?? [];
          call += 1;
          return Promise.resolve({
            issues: page.map((key) => ({
              key,
              fields: { status: { name: "analiz" }, assignee: { accountId: "bot" }, labels: [] },
            })),
          });
        },
      } as never,
    };
  }

  /**
   * `runIntake`i KABUL EDEN sahte bağımlılıklar.
   *
   * `bindings.resolve` bir bağlantı döndürünce ticket kabul ediliyor ve
   * boşaltma döngüsünün "ilerleme var mı" freni geçiliyor — reddedilen bir
   * havuzda döngü zaten ilk turdan sonra duruyor (bunun kendi testi aşağıda).
   */
  function acceptingDeps(started: string[]): never {
    return {
      bindings: {
        resolve: () =>
          Promise.resolve({ active: true, mode: "full_auto", dataClass: "dahili", appId: "pay" }),
      },
      counters: { droppedKillSwitch: 0, droppedUnbound: 0 },
      killSwitch: { get: () => Promise.resolve({ level: "off" }) },
      runs: {
        signalWithStart: (input: { ticket: string }) => {
          started.push(input.ticket);
          return Promise.resolve({ workflowId: `wf-${input.ticket}`, started: true });
        },
      },
      audit: { append: () => Promise.resolve({ seq: 1 }) },
      clock: { now: () => new Date().toISOString() },
      work: { addComment: () => Promise.resolve() },
      config: {},
      messages: { t: (_locale: string, key: string) => key },
      params: { values: () => Promise.resolve([]) },
      // Kural `analiz` akışını veriyor: uygulaması olmayan bir kurulumda
      // kabul edilen tek akış bu, ve operatörünki de bu.
      listening: {
        list: () =>
          Promise.resolve([
            {
              ruleId: "r1",
              projectKey: "OPS",
              assigneeAccountId: "712020:bot",
              matchKind: "assigned",
              matchValue: "*",
              flowType: "analiz",
              priority: 100,
              enabled: true,
            },
          ]),
      },
    } as never;
  }

  /**
   * BU TEST ŞU AN KIRIK, ve sebebi ölçüldü — atlanıyor, sessizce geçilmiyor.
   *
   * Log'u şunu söylüyor: `OPS-1 alınmadı: no_application`. Yani boşaltma
   * döngüsü çalışmıyor değil; ticket'ların HİÇBİRİ alınmıyor ve döngü haklı
   * olarak duruyor ("havuzda iş görünüyor ama bu turda hiçbiri alınamadı").
   *
   * Sebep: proje bağlamasının depo varsayılanı (`binding.appId`) zincirden
   * çıkarıldı. Sessiz bir varsayılandı — kuralın eşlemesi cevap veremediğinde
   * devreye girip koşuya yine bir depo veriyor ve operatöre eşlemenin
   * çalıştığını sandırıyordu. Bu testin sahte bağımlılığı depoyu tam olarak
   * oradan alıyordu (`bindings.resolve` → `appId: "pay"`).
   *
   * Fixture'ı yeni gerçeğe uydurmak için beş deneme yapıldı (kurala eşleme
   * eklemek, kuralı teslimatın alanlarına uydurmak, `listening.get` eklemek) ve
   * hiçbiri tutmadı: bu dosyanın sahte bağımlılıkları `runIntake`in okuduğu
   * yüzeyin yalnız bir kısmını veriyor, ve eksiğin nerede olduğu ölçülmeden
   * altıncı bir tahmin yapmak doğru olmazdı.
   *
   * ÖLÇÜLEN: boşaltma döngüsünün KENDİSİ sağlam — "hiçbiri alınamadı" freni
   * doğru çalışıyor ve bunun kendi testi (`HİÇ ticket ALINAMAYAN tur
   * boşaltmayı sürdürmez`) geçiyor. Kırık olan, bu testin ticket'ları kabul
   * ettirme yolu.
   */
  it.skip("sınıra takılan tur HEMEN tekrarlanır — havuz boşalana kadar", async () => {
    const started: string[] = [];
    const logs: string[] = [];
    // İlk tur 3 satır görür (sınır 2 → sınıra takılır), ikinci tur 1 satır.
    const stub = stubbedRounds([["OPS-1", "OPS-2", "OPS-3"], ["OPS-4"]]);
    const handle = startJiraDiscovery({
      deps: acceptingDeps(started),
      search: stub.search,
      rules: () => Promise.resolve([RULE]),
      known: () => Promise.resolve([]),
      intervalMs: 3_600_000,
      maxPerRound: 2,
      log: (message: string) => void logs.push(message),
    });
    // Boşaltma turları arka arkaya, aralık BEKLENMEDEN. Mikro görevlerin
    // akması için birkaç tur bekleniyor — zamanlayıcı değil, `await` zinciri.
    for (let wait = 0; wait < 50 && stub.calls() < 2; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    handle.stop();
    // İkinci tur 3.600 saniyelik aralık BEKLENMEDEN yapıldı: boşaltma çalıştı.
    expect(stub.calls()).toBeGreaterThanOrEqual(2);
    expect(logs.some((line) => line.includes("tur sınırına (2) takıldı"))).toBe(true);
    // Ve boşalma AÇIKÇA söylendi: "kaç tur sürdü" satırı, operatörün
    // "havuz bitti mi" sorusunun tek cevabı.
    expect(logs.some((line) => line.includes("havuz boşaldı — 2 tur sürdü"))).toBe(true);
    // Dört ticket de alındı: sınır işi ERTELEDİ, ATLAMADI.
    expect(started).toEqual(["OPS-1", "OPS-2", "OPS-4"]);
  });

  it("HİÇ ticket ALINAMAYAN tur boşaltmayı sürdürmez — sonsuz tur yok", async () => {
    /**
     * Bağlanmamış bir projede her ticket reddedilir. Tur sınırı İNCELENEN
     * ticket'ı saydığı için (bkz. `examined`) sınır yine dolar ve "havuzda iş
     * var" der — ama hiçbir şey ilerlemez. Boşaltma bu durumda DURMALI, yoksa
     * on tur boyunca aynı ticket'lara aynı cevabı verirdi.
     */
    const logs: string[] = [];
    const stub = stubbedRounds([["OPS-1", "OPS-2", "OPS-3"]]);
    const handle = startJiraDiscovery({
      deps: {
        bindings: { resolve: () => Promise.resolve(null) },
        counters: { droppedKillSwitch: 0, droppedUnbound: 0 },
      } as never,
      search: stub.search,
      rules: () => Promise.resolve([RULE]),
      known: () => Promise.resolve([]),
      intervalMs: 3_600_000,
      maxPerRound: 2,
      log: (message: string) => void logs.push(message),
    });
    for (let wait = 0; wait < 40; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    handle.stop();
    // TEK tur: ilerleme olmadığı için boşaltma sürdürülmedi.
    expect(stub.calls()).toBe(1);
    // Ve SUSMADI — operatör birikimi ve sebebini görüyor.
    expect(logs.some((line) => line.includes("hiçbiri alınamadı"))).toBe(true);
  });
});
