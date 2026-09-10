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
