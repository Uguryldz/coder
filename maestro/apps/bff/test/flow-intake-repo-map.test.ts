import { describe, expect, it } from "vitest";
import type { ListeningRuleRecord } from "../src/listening-store.js";
import { TEST_APPLICATIONS, harness, testApplication } from "./helpers.js";
import { issueEvent, signed } from "./payloads.js";

/**
 * The repo map decides the APPLICATION per ticket: the matched rule's Jira
 * field value selects a row; no row (or no map) keeps the project binding's
 * app, exactly as before.
 */
function rule(over: Partial<ListeningRuleRecord> = {}): ListeningRuleRecord {
  return {
    ruleId: "lr_map",
    projectKey: "UGURPAY",
    assigneeAccountId: "",
    matchKind: "issuetype",
    matchValue: "Hata",
    flowType: "duzeltme",
    priority: 100,
    enabled: true,
    repoMap: {
      field: "customfield_10234",
      fieldName: "İş Ailesi",
      entries: [
        { value: "Krediler", appId: "bank/kredi", targetBranch: "develop" },
        { value: "Kartlar", appId: "bank/kart" },
      ],
    },
    ...over,
  };
}

/**
 * Esleme fixture'larinin gosterdigi depolar, envanterde KAYITLI.
 *
 * Alim artik kosuyu acmadan once appId'nin `Application` tablosunda oldugunu
 * dogruluyor (OPS-121). Bu dosya eslemenin DOGRU appId'yi sectigini olcuyor,
 * kayit kapisini degil — o kapinin kendi testi asagida.
 */
const MAPPED_APPS = [
  ...TEST_APPLICATIONS,
  testApplication("bank/kredi", "bank", "kredi"),
  testApplication("bank/kart", "bank", "kart"),
];

async function deliver(h: Awaited<ReturnType<typeof harness>>, ticket: string): Promise<{ appId?: string; targetBranch?: string } | undefined> {
  const before = h.runs.started.length;
  const delivery = signed(issueEvent({ ticket, issueType: "Hata" }));
  const response = await h.app.inject({ method: "POST", url: "/webhooks/jira", headers: delivery.headers, payload: delivery.payload });
  expect(response.statusCode).toBe(202);
  return h.runs.started[before] as { appId?: string; targetBranch?: string } | undefined;
}

/**
 * Arama ticket'ın METNİNİ okur, sınıflandırma alanlarını değil — özet ve
 * açıklama tam da aranacak terimlerin yaşadığı yerdir. Seed edilmemiş bir
 * ticket'ta `getTicket` fırlatır (bilerek: cevap vermeyen bir Jira), yani
 * metin okunamaz ve arama hiç konuşamaz.
 */
const seedTicket = (h: Awaited<ReturnType<typeof harness>>, ticket: string): void => {
  h.work.putTicket({
    key: ticket,
    projectKey: "UGURPAY",
    issueType: "Hata",
    summary: "Kredi limiti ekranında bakiye yanlış",
    description: "Kredi başvurusunda limit hesabı hatalı çalışıyor.",
    reporter: "can.ozturk",
    assignee: "712020:maestro-bot",
    components: [],
    labels: [],
    parentKey: null,
    createdAt: "2026-08-09T09:00:00.000Z",
    updatedAt: "2026-08-09T09:00:00.000Z",
  });
};

describe("intake — repo map picks the application", () => {
  it("a fixed map sends every ticket of the rule to its application without reading any field", async () => {
    const h = await harness({
      applications: MAPPED_APPS,
      listeningRules: [rule({ repoMap: { field: "*", entries: [{ value: "*", appId: "bank/kart", targetBranch: "test" }] } })],
    });
    expect((await deliver(h, "UGURPAY-9"))?.appId).toBe("bank/kart");
    expect(h.work.fieldReads).toEqual([]);
  });

  it("routes the ticket to the app its field value maps to (case/whitespace tolerant)", async () => {
    const h = await harness({ applications: MAPPED_APPS, listeningRules: [rule()] });
    h.work.putFields("UGURPAY-1", { customfield_10234: " krediler " });
    const started = await deliver(h, "UGURPAY-1");
    expect(started?.appId).toBe("bank/kredi");
    expect(started?.targetBranch).toBe("develop");
    expect(h.work.fieldReads).toEqual([{ ticket: "UGURPAY-1", fieldIds: ["customfield_10234"] }]);
  });

  it("keeps the project binding's app when the value matches no row", async () => {
    const h = await harness({ applications: MAPPED_APPS, listeningRules: [rule()] });
    h.work.putFields("UGURPAY-2", { customfield_10234: "Sigorta" });
    const started = await deliver(h, "UGURPAY-2");
    expect(started?.appId).toBe("ugurpay");
    expect(started?.targetBranch).toBeUndefined();
  });

  it("keeps the project binding's app when the rule has no map, and reads no field", async () => {
    const h = await harness({ applications: MAPPED_APPS, listeningRules: [rule({ repoMap: null })] });
    expect((await deliver(h, "UGURPAY-3"))?.appId).toBe("ugurpay");
    expect(h.work.fieldReads).toEqual([]);
  });
});

/**
 * KATMAN 2 — KOSU ACILMADAN (VE KLON ACILMADAN) ONCE KONTROL (OPS-121).
 *
 * Canlida olculen sira: esleme dogru cozuldu ve log yazdi → `signalWithStart`
 * cagrildi → depo KLONLANDI (`checkoutOrNull` → `prepareWorkspace`) → kosu
 * satiri `WorkflowRun_appId_fkey` ile reddedildi. Disk harcandi, ticket
 * islenmedi, operatorun elinde ham bir Prisma hatasi kaldi.
 *
 * Klon `signalWithStart`in ARDINDAN acildigi icin, bu testlerin olctugu sey
 * `h.runs.started`in BOS kalmasi: `signalWithStart` hic cagrilmadiysa klon da
 * hic acilmaz. Bu, "hata daha nazik" ile "hata artik olusmuyor" arasindaki
 * farkin kendisi.
 */
/**
 * ── TICKET HANGİ DEPOYU İLGİLENDİRİYOR — KODA SORARAK ───────────────────────
 *
 * Depo eşlemesi operatöre "hangi depo" diye sorar ve bu, on depolu bir projede
 * işler. Sahada kırıldığı yer: bir Azure DevOps projesinde ONLARCA depo var ve
 * ticket'ın hangisini ilgilendirdiğini kimse bilmiyor — ne operatör, ne kural.
 * Eşleme yazamayan operatörün elinde bugüne kadar proje bağlamasının varsayılan
 * deposu vardı, yani neredeyse her zaman YANLIŞ depo.
 *
 * Buradaki testlerin tuttuğu asıl şey SIRA: arama bir TAHMİNDİR ve bir tahmin,
 * insanın ya da operatörün açık kararını asla ezmemelidir.
 */
describe("intake — kod aramasıyla depo bulma", () => {
  const found = (repo: string) => () => Promise.resolve({ repo, why: "kod aramasında 12 eşleşme" });


  it("picks the repository code search found when no rule and no human named one", async () => {
    const h = await harness({
      applications: MAPPED_APPS,
      listeningRules: [rule({ repoMap: null })],
      repoSearch: found("bank/kredi"),
    });
    expect((seedTicket(h, "UGURPAY-40"), await deliver(h, "UGURPAY-40"))?.appId).toBe("bank/kredi");
  });

  /**
   * SIRA: kuralın eşlemesi aramanın ÖNÜNDE. Operatör bir satır yazdıysa
   * cevabını biliyor demektir; bir tahminin onu ezmesi, ayarı sessizce
   * geçersiz kılmak olurdu.
   */
  it("never overrides the rule's own map", async () => {
    const calls: string[] = [];
    const h = await harness({
      applications: MAPPED_APPS,
      listeningRules: [rule()],
      repoSearch: (request) => {
        calls.push(request.text);
        return Promise.resolve({ repo: "bank/kart", why: "kod araması" });
      },
    });
    seedTicket(h, "UGURPAY-41");
    h.work.putFields("UGURPAY-41", { customfield_10234: "Krediler" });
    expect((seedTicket(h, "UGURPAY-41"), await deliver(h, "UGURPAY-41"))?.appId).toBe("bank/kredi");
    // Eşleme cevap verdiği için arama HİÇ çağrılmadı: gereksiz bir ağ çağrısı
    // değil, gereksiz bir tahmin de yok.
    expect(calls).toEqual([]);
  });

  /**
   * "Aradım, bulamadım" ile "arama kurulu değil" AYRI hâllerdir ama ikisi de
   * aynı yere düşer: proje bağlaması. Arama bir EK, bir koşul değil — bir
   * arama arızası ticket'ın hiç işlenmemesine yol açmamalı.
   */
  it("falls back to the project binding when the search finds nothing", async () => {
    const h = await harness({
      applications: MAPPED_APPS,
      listeningRules: [rule({ repoMap: null })],
      repoSearch: () => Promise.resolve(null),
    });
    seedTicket(h, "UGURPAY-42");
    const started = await deliver(h, "UGURPAY-42");
    expect(started?.appId).toBe(TEST_APPLICATIONS[0]!.appId);
  });

  it("behaves exactly as before when no search is wired at all", async () => {
    const h = await harness({ applications: MAPPED_APPS, listeningRules: [rule({ repoMap: null })] });
    expect((seedTicket(h, "UGURPAY-43"), await deliver(h, "UGURPAY-43"))?.appId).toBe(TEST_APPLICATIONS[0]!.appId);
  });

  it("a search failure does not stop the ticket from being processed", async () => {
    const h = await harness({
      applications: MAPPED_APPS,
      listeningRules: [rule({ repoMap: null })],
      repoSearch: () => Promise.reject(new Error("almsearch unreachable")),
    });
    expect((seedTicket(h, "UGURPAY-44"), await deliver(h, "UGURPAY-44"))?.appId).toBe(TEST_APPLICATIONS[0]!.appId);
  });
});

/**
 * ── "PROJEYİ SEÇ, DEPOYU SİSTEM BULSUN" ─────────────────────────────────────
 *
 * İlk iki kip operatörden bir DEPO adı ister. Onlarca depolu bir ADO projesinde
 * ikisi de cevaplanamaz: ticket'ın hangi depoyu ilgilendirdiğini kimse bilmiyor.
 * Bu kipte operatör yalnız PROJEYİ söyler, depoyu kod araması bulur.
 */
describe("intake — projeyi seç, depoyu arama bulsun", () => {
  const searchMap = (project: string) => ({ field: "?", entries: [{ value: "*", appId: project }] });

  it("searches instead of treating the project name as a repository", async () => {
    const asked: { text: string; project?: string }[] = [];
    const h = await harness({
      applications: MAPPED_APPS,
      listeningRules: [rule({ repoMap: searchMap("Bankacılık") })],
      repoSearch: (request) => {
        asked.push(request);
        return Promise.resolve({ repo: "bank/kredi", why: "kod aramasında 12 eşleşme" });
      },
    });
    seedTicket(h, "UGURPAY-50");
    expect((await deliver(h, "UGURPAY-50"))?.appId).toBe("bank/kredi");
    /**
     * Aranan proje KURALDAN gelir, Jira'nın proje anahtarından değil: Jira
     * projesi "UGURPAY" iken kodun yaşadığı ADO projesi "Bankacılık" olabilir
     * ve o hâlde arama yanlış projede arardı.
     */
    expect(asked[0]?.project).toBe("Bankacılık");
  });

  it("falls back to the project binding when the search cannot answer", async () => {
    const h = await harness({
      applications: MAPPED_APPS,
      listeningRules: [rule({ repoMap: searchMap("Bankacılık") })],
      repoSearch: () => Promise.resolve(null),
    });
    seedTicket(h, "UGURPAY-51");
    // Kural "ara" diyor ama arama bulamadı: `appId: ""` asla bir depo olarak
    // kullanılmamalı — o boş dize klonu anlamsız bir adla denerdi.
    expect((await deliver(h, "UGURPAY-51"))?.appId).toBe(TEST_APPLICATIONS[0]!.appId);
  });

  it("still lets a human override the search with /ai-assign", async () => {
    const calls: unknown[] = [];
    const h = await harness({
      applications: MAPPED_APPS,
      listeningRules: [rule({ repoMap: searchMap("Bankacılık") })],
      repoSearch: (request) => {
        calls.push(request);
        return Promise.resolve({ repo: "bank/kredi", why: "kod araması" });
      },
    });
    seedTicket(h, "UGURPAY-52");
    // Not: elle atama yolunun kendi testleri var; burada tutulan şey, arama
    // kipinin o yolu ENGELLEMEDİĞİ — karar zincirinde en önde insan durur.
    expect((await deliver(h, "UGURPAY-52"))?.appId).toBe("bank/kredi");
    expect(calls).toHaveLength(1);
  });
});

describe("intake — an unregistered application stops the run BEFORE it starts", () => {
  it("refuses by name and never calls signalWithStart, so no clone is opened", async () => {
    // Sabit esleme `bank/kart`i gosteriyor ama envanterde YOK — canliyi
    // ureten hâl.
    const h = await harness({
      applications: TEST_APPLICATIONS,
      listeningRules: [rule({ repoMap: { field: "*", entries: [{ value: "*", appId: "bank/kart" }] } })],
    });

    const before = h.runs.started.length;
    const delivery = signed(issueEvent({ ticket: "UGURPAY-11", issueType: "Hata" }));
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.statusCode).toBe(202);
    // ADLANDIRILMIS red — `no_application` degil: orada hicbir uygulama
    // soylenmemistir, burada soylenmis ama kayitli degildir, ve operatorun
    // yapacagi is farklidir.
    expect(response.json()).toMatchObject({ accepted: false, reason: "unknown_application" });
    // KRITIK: kosu ACILMADI, dolayisiyla klon da acilmadi.
    expect(h.runs.started.length).toBe(before);
  });

  it("says so ON THE TICKET, naming the repository", async () => {
    const h = await harness({
      applications: TEST_APPLICATIONS,
      listeningRules: [rule({ repoMap: { field: "*", entries: [{ value: "*", appId: "bank/kart" }] } })],
    });

    const delivery = signed(issueEvent({ ticket: "UGURPAY-12", issueType: "Hata" }));
    await h.app.inject({ method: "POST", url: "/webhooks/jira", headers: delivery.headers, payload: delivery.payload });

    const comment = h.work.comments.find((entry) => entry.ticket === "UGURPAY-12")?.body ?? "";
    expect(comment).toContain("bank/kart");
    // "Atama bekliyor" DEGIL: o cumle operatoru yanlis ise gonderirdi.
    expect(comment).not.toContain("atama bekliyor");
  });

  it("writes the reason into the decision log", async () => {
    const lines: string[] = [];
    const h = await harness({
      applications: TEST_APPLICATIONS,
      listeningRules: [rule({ repoMap: { field: "*", entries: [{ value: "*", appId: "bank/kart" }] } })],
      deps: { decisionLog: (line: string) => void lines.push(line) },
    });

    const delivery = signed(issueEvent({ ticket: "UGURPAY-13", issueType: "Hata" }));
    await h.app.inject({ method: "POST", url: "/webhooks/jira", headers: delivery.headers, payload: delivery.payload });

    expect(lines.join("\n")).toContain("alınmadı (unknown_application)");
  });

  it("also guards the app the PROJECT BINDING names, not only the mapped one", async () => {
    // Depo esleme yok; baglamanin uygulamasi kullanilir. Envanteri bos birakmak
    // "baglandi ama depo silindi" halini kurar — ayni yabancı anahtar hatasi.
    const h = await harness({ applications: [], listeningRules: [rule({ repoMap: null })] });

    const before = h.runs.started.length;
    const delivery = signed(issueEvent({ ticket: "UGURPAY-14", issueType: "Hata" }));
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.json()).toMatchObject({ accepted: false, reason: "unknown_application" });
    expect(h.runs.started.length).toBe(before);
  });

  /**
   * "KAYIT YOK" ile "OKUYAMADIM" ayri: envanteri OKUYAMAMAK hicbir sey
   * olcmez, ve o hâlde reddetmek gecici bir veritabani arizasini "hicbir
   * ticket alinmiyor"a cevirirdi — teshis kontrolu, engelledigi arizadan
   * buyuk bir ariza uretirdi.
   */
  it("envanter OKUNAMAZSA bugunku gibi davranir — kosu acilir", async () => {
    const h = await harness({ applications: MAPPED_APPS, listeningRules: [rule()] });
    h.read.apps.get = () => Promise.reject(new Error("registry down"));
    h.work.putFields("UGURPAY-16", { customfield_10234: "Krediler" });

    expect((await deliver(h, "UGURPAY-16"))?.appId).toBe("bank/kredi");
  });

  it("REGRESYON: kayitli bir depoya esleyen kural bugunku gibi calisir", async () => {
    const h = await harness({ applications: MAPPED_APPS, listeningRules: [rule()] });
    h.work.putFields("UGURPAY-15", { customfield_10234: "Krediler" });

    const started = await deliver(h, "UGURPAY-15");

    expect(started?.appId).toBe("bank/kredi");
    expect(started?.targetBranch).toBe("develop");
  });
});
