import { describe, expect, it } from "vitest";
import {
  buildConfigFindings,
  worstSeverity,
  type ConfigFinding,
  type ConfigHealthInput,
  type DeploymentConfigFacts,
} from "../src/config-health.js";
import { auth } from "./helpers.js";
import { adminToken, memberToken, studioHarness } from "./studio-fixtures.js";

/**
 * Yapılandırma teşhisi — panelin "bu kurulum NASIL kurulmuş" satırları.
 *
 * Buradaki testlerin çoğu bir RENK sınıyor, ve bu bilinçli: bu ekranın bütün
 * değeri hangi satırın kırmızı olduğunda. Kapalı ağda webhook sırrının
 * olmayışını kırmızıya boyamak, operatöre kırmızıyı yok saymayı öğretir — ve o
 * alışkanlık kurulduktan sonra gerçek bir bulgu da görülmez.
 */

const DC: DeploymentConfigFacts = {
  workDriver: "jira-dc",
  workDriverVariable: "JIRA_BASE_URL",
  cloudUrlLooksLikeCloud: true,
  sweepEnabled: true,
  sweepSeconds: 300,
  sweepSource: "varsayilan",
  sweepOffReason: null,
  webhookSecretConfigured: false,
  canMoveStatus: true,
};

/** Her şeyi bilen, her şeyi doğru olan bir kurulum — sapmaları buradan üretiyoruz. */
const HEALTHY: ConfigHealthInput = {
  deployment: { ...DC, webhookSecretConfigured: true },
  intake: { mode: "both", pollSeconds: 60, canReadComments: true, source: "param" },
  clarify: { state: "open", source: "connection" },
  variants: { scanned: 4, cloudModelVariants: [] },
  statusMaps: { ruleCount: 3, mappedRuleCount: 2, gateStatusRuleCount: 1, gateStatusConflictCount: 0 },
  ruleIdentity: {
    ruleCount: 3,
    staleRuleCount: 0,
    staleAccountCount: 0,
    internalKeyRuleCount: 0,
    connectionKnown: true,
  },
  gateGroups: { configured: true },
};

function row(findings: readonly ConfigFinding[], id: string): ConfigFinding {
  const found = findings.find((finding) => finding.id === id);
  expect(found, `beklenen satır yok: ${id}`).toBeDefined();
  return found as ConfigFinding;
}

describe("buildConfigFindings", () => {
  it("names the Jira driver and the VARIABLE that chose it, never the address", () => {
    const findings = buildConfigFindings(HEALTHY);
    const driver = row(findings, "jira_driver");

    expect(driver.value).toBe("jira-dc");
    expect(driver.severity).toBe("iyi");
    expect(driver.detailParams).toEqual({ variable: "JIRA_BASE_URL" });
    // Sızıntı testi: serileşmiş yanıtın hiçbir yerinde bir adres olamaz.
    expect(JSON.stringify(findings)).not.toMatch(/https?:\/\//);
  });

  /**
   * Bu turun bütün sebebi: sürücü satırı DOĞRU cümleyi kuruyordu ve yine de
   * yanlış kurulumu yeşil gösteriyordu. "Cloud, çünkü JIRA_CLOUD_BASE_URL
   * dolu" — doğru; eksik olan, o değişkenin içindeki adresin bir Cloud adresi
   * olmadığıydı.
   */
  it("bir Cloud sürücüsünün altında Cloud'a benzemeyen adres UYARIdır", () => {
    const findings = buildConfigFindings({
      ...HEALTHY,
      deployment: {
        ...DC,
        workDriver: "jira-cloud",
        workDriverVariable: "JIRA_CLOUD_BASE_URL",
        cloudUrlLooksLikeCloud: false,
      },
    });
    const driver = row(findings, "jira_driver");

    expect(driver.severity).toBe("uyari");
    expect(driver.detailKey).toBe("config.detail.jira_driver.url_not_cloud");
    expect(driver.fixKey).toBe("config.fix.jira_driver.url_not_cloud");
    // Yalnız değişken ADI taşınır — adres bu pakete zaten hiç girmedi.
    expect(driver.detailParams).toEqual({ variable: "JIRA_CLOUD_BASE_URL" });
    expect(JSON.stringify(findings)).not.toMatch(/https?:\/\//);
    // Uyarı, kırmızı değil: Cloud'un önündeki bir kurum vekili bu satırı
    // haklı çıkarabilir, ve yanılabilen bir işaret kırmızı olmamalı.
    expect(worstSeverity(findings)).not.toBe("sorun");
  });

  it("ters yön aynı desende: DC sürücüsünün altında bir Cloud adresi", () => {
    const driver = row(
      buildConfigFindings({
        ...HEALTHY,
        deployment: { ...DC, cloudUrlLooksLikeCloud: false },
      }),
      "jira_driver",
    );

    expect(driver.severity).toBe("uyari");
    expect(driver.detailKey).toBe("config.detail.jira_driver.url_is_cloud");
    expect(driver.fixKey).toBe("config.fix.jira_driver.url_is_cloud");
    expect(driver.detailParams).toEqual({ variable: "JIRA_BASE_URL" });
  });

  it("soru anlamsızsa (null) satır yeşil kalır — uydurulmuş bir uyarı yok", () => {
    const driver = row(
      buildConfigFindings({
        ...HEALTHY,
        deployment: { ...DC, cloudUrlLooksLikeCloud: null },
      }),
      "jira_driver",
    );

    expect(driver.severity).toBe("iyi");
    expect(driver.detailKey).toBe("config.detail.jira_driver.chosen");
  });

  it("an unconfigured Jira is the loudest row on the screen", () => {
    const findings = buildConfigFindings({
      ...HEALTHY,
      deployment: { ...DC, workDriver: "not-configured", workDriverVariable: null },
    });

    const driver = row(findings, "jira_driver");
    expect(driver.severity).toBe("sorun");
    expect(driver.value).toBe("yapilandirilmamis");
    expect(driver.fixKey).toBe("config.fix.jira_driver.none");
    // Sıralama sunucudan gelir: sorunlu satır en üstte.
    expect(findings[0]?.id).toBe("jira_driver");
  });

  /**
   * Bu ekranın en kolay yanlış yapılabilecek satırı, ve görevin açıkça
   * istediği davranış: DC'de webhook olmayabilir, ve o durum bir hata gibi
   * GÖRÜNMEMELİ.
   */
  it("a missing webhook secret is a NOTE, not a fault, when the sweep is running", () => {
    const findings = buildConfigFindings({ ...HEALTHY, deployment: DC });
    const webhook = row(findings, "webhook");

    expect(webhook.severity).toBe("bilgi");
    expect(webhook.value).toBe("tanimsiz");
    // Ve bütün ekranı kırmızıya boyamaz.
    expect(worstSeverity(findings)).not.toBe("sorun");
  });

  it("reports the sweep interval and WHO set it", () => {
    const onDefault = row(buildConfigFindings(HEALTHY), "sweep");
    expect(onDefault.detailKey).toBe("config.detail.sweep.on_default");
    expect(onDefault.detailParams).toEqual({ seconds: "300" });

    const fromEnv = row(
      buildConfigFindings({
        ...HEALTHY,
        deployment: { ...DC, sweepSource: "env", sweepSeconds: 120 },
      }),
      "sweep",
    );
    expect(fromEnv.detailKey).toBe("config.detail.sweep.on_env");
  });

  it("keeps the two reasons a sweep is off apart — they need two different fixes", () => {
    const byChoice = row(
      buildConfigFindings({
        ...HEALTHY,
        deployment: { ...DC, sweepEnabled: false, sweepSeconds: 0, sweepOffReason: "kapatildi" },
      }),
      "sweep",
    );
    expect(byChoice.fixKey).toBe("config.fix.sweep.off_setting");

    const byDriver = row(
      buildConfigFindings({
        ...HEALTHY,
        deployment: {
          ...DC,
          sweepEnabled: false,
          sweepSeconds: 0,
          sweepOffReason: "surucu-arama-sunmuyor",
        },
      }),
      "sweep",
    );
    // .env'e gönderilmiyor: değiştirecek bir satır yok.
    expect(byDriver.fixKey).toBe("config.fix.sweep.off_driver");
  });

  it("a driver that cannot read comments is a problem, not merely 'polling off'", () => {
    const findings = buildConfigFindings({
      ...HEALTHY,
      intake: { mode: "webhook", pollSeconds: 0, canReadComments: false, source: "default" },
    });
    expect(row(findings, "intake").severity).toBe("sorun");
  });

  it("a missing bot identity is a problem; a missing ticket reader is only a warning", () => {
    const noIdentity = buildConfigFindings({
      ...HEALTHY,
      clarify: { state: "closed", reason: "no_bot_account" },
    });
    expect(row(noIdentity, "clarify").severity).toBe("sorun");
    expect(row(noIdentity, "clarify").fixKey).toBe("config.fix.clarify.no_bot_account");

    const noReader = buildConfigFindings({
      ...HEALTHY,
      clarify: { state: "closed", reason: "no_ticket_reader" },
    });
    // Webhook yolu bundan etkilenmiyor, o yüzden alarm değil.
    expect(row(noReader, "clarify").severity).toBe("uyari");
  });

  it("names the agent variants carrying a cloud model, and never their model name", () => {
    const findings = buildConfigFindings({
      ...HEALTHY,
      variants: { scanned: 4, cloudModelVariants: ["analist-v2", "muhendis"] },
    });
    const variants = row(findings, "variant_models");

    expect(variants.severity).toBe("sorun");
    expect(variants.detailParams).toEqual({ variants: "analist-v2, muhendis" });
    expect(variants.fixKey).toBe("config.fix.variant_models.cloud");
  });

  it("a status map on a driver that cannot move a ticket is the silent contradiction", () => {
    const findings = buildConfigFindings({
      ...HEALTHY,
      deployment: { ...DC, canMoveStatus: false },
      statusMaps: { ruleCount: 3, mappedRuleCount: 2, gateStatusRuleCount: 1, gateStatusConflictCount: 0 },
    });
    expect(row(findings, "status_map").severity).toBe("sorun");
  });

  it("comment-only mode is the product default, so it is a note rather than a fault", () => {
    const findings = buildConfigFindings({
      ...HEALTHY,
      statusMaps: { ruleCount: 3, mappedRuleCount: 0, gateStatusRuleCount: 0, gateStatusConflictCount: 0 },
    });
    expect(row(findings, "status_map").severity).toBe("bilgi");
  });

  /**
   * "Bilmiyoruz" ile "iyi" arasındaki fark bu ekranın bütün varlık sebebi:
   * kablolanmamış bir kurulumda yeşil satır göstermek, kapatmaya geldiği
   * sessiz-yanlış sınıfının ta kendisi olurdu.
   */
  it("an unwired deployment reports 'unknown', never a fabricated green", () => {
    const findings = buildConfigFindings({
      deployment: null,
      intake: null,
      clarify: null,
      variants: null,
      statusMaps: null,
      ruleIdentity: null,
    gateGroups: null,
    });

    // Dokuz satır: kapı onay yolu (`gate_channel`) sekizincinin yanına eklendi.
    // Sayı sabitlenmiş kalıyor ve bilerek: yeni bir satırın "bilinmiyor"
    // demeyi UNUTMASI, tam olarak bu testin yakalamak için var olduğu şey.
    expect(findings).toHaveLength(10);
    expect(findings.every((finding) => finding.value === "bilinmiyor")).toBe(true);
    expect(findings.some((finding) => finding.severity === "iyi")).toBe(false);
  });

  /**
   * KURALLARIN BOT HESABI — bankada saatler yakan sessiz-yanlışın panele çıkan
   * hâli.
   *
   * DC `/myself` bir kullanıcıyı iki alanla adlandırır: `name` ("ugyildiz",
   * kullanıcı adı) ve `key` ("jirauser13506", iç tutamak). Yoklama `key`i
   * okuyordu, o değer kurallara tohumlandı, ve JQL `assignee`yi kullanıcı
   * adıyla çözdüğü için her tarama boş döndü — Jira eşleşmeyen bir kimliğe hata
   * değil 200 + boş sayfa cevabı verdiği için hiçbir ekranda görünmüyordu.
   * Sahada doğrulandı: atama kullanıcı adıyla sorulunca ticket'lar geldi.
   */
  describe("kuralların bot hesabı", () => {
    it("kural bağlantıdan BAŞKA bir kimlik taşıyorsa SORUN — tarama sessizce boş döner", () => {
      const findings = buildConfigFindings({
        ...HEALTHY,
        ruleIdentity: {
          ruleCount: 4,
          staleRuleCount: 3,
          staleAccountCount: 1,
          internalKeyRuleCount: 3,
          connectionKnown: true,
        },
      });
      const identity = row(findings, "rule_identity");
      expect(identity.severity).toBe("sorun");
      expect(identity.value).toBe("ayrisik");
      expect(identity.detailParams).toEqual({ stale: "3", rules: "4", accounts: "1" });
      // Çözümü olan bir satır, çözümünü de söyler.
      expect(identity.fixKey).not.toBeNull();
    });

    /**
     * DESEN, KIYASTAN AYRI. Bağlantı hiç test edilmemiş olabilir — ya da o da
     * aynı yanlış değeri taşıyor olabilir, ki bu bankadaki gerçek durumdu: iki
     * katman da `key`i okuduğu için ayrışma YOKTU, arıza yine de vardı.
     *
     * `uyari`, `sorun` değil: desen bir tahmin, ve bazı DC kurulumlarında `key`
     * gerçekten kullanıcı adına eşittir. Yanılabilen bir işareti kırmızıya
     * boyamak, operatöre kırmızıyı yok saymayı öğretir.
     */
    it("bağlantı da aynı iç kimliği taşısa bile deseni UYARI olarak söyler", () => {
      const findings = buildConfigFindings({
        ...HEALTHY,
        ruleIdentity: {
          ruleCount: 4,
          // Ayrışma yok: bağlantı ile kurallar HEMFİKİR — ve ikisi de yanlış.
          staleRuleCount: 0,
          staleAccountCount: 0,
          internalKeyRuleCount: 4,
          connectionKnown: true,
        },
      });
      const identity = row(findings, "rule_identity");
      expect(identity.severity).toBe("uyari");
      expect(identity.value).toBe("ic-kimlik");
      expect(identity.detailParams).toEqual({ affected: "4", rules: "4" });
    });

    it("bağlantı test edilmemişse 'uyumlu' DEMEZ — yapılmamış bir kıyası bildirmek olurdu", () => {
      const findings = buildConfigFindings({
        ...HEALTHY,
        ruleIdentity: {
          ruleCount: 2,
          staleRuleCount: 0,
          staleAccountCount: 0,
          internalKeyRuleCount: 0,
          connectionKnown: false,
        },
      });
      const identity = row(findings, "rule_identity");
      expect(identity.value).toBe("kiyaslanamadi");
      expect(identity.severity).toBe("bilgi");
    });

    it("kimlikler uyuşuyorsa yeşil, ve yanında düzeltilecek bir şey yazmaz", () => {
      const identity = row(buildConfigFindings(HEALTHY), "rule_identity");
      expect(identity.severity).toBe("iyi");
      expect(identity.value).toBe("uyumlu");
      expect(identity.fixKey).toBeNull();
    });

    it("hiç kural yokken ayrışma İDDİA ETMEZ", () => {
      const identity = row(
        buildConfigFindings({
          ...HEALTHY,
          ruleIdentity: {
            ruleCount: 0,
            staleRuleCount: 0,
            staleAccountCount: 0,
            internalKeyRuleCount: 0,
            connectionKnown: true,
          },
        }),
        "rule_identity",
      );
      expect(identity.value).toBe("kural-yok");
      expect(identity.severity).toBe("bilgi");
    });

    /**
     * SIR SIZDIRMAMA. Bu dosyanın başındaki sözleşme: bu yanıttan hiçbir DEĞER
     * çıkmaz, yalnız sayılar ve kapalı durumlar. Kimliğin kendisi — sır olmasa
     * bile — bu yanıtın sözleşmesine ait değil.
     */
    it("kimliklerin KENDİSİNİ yanıta koymaz, yalnız sayar", () => {
      const findings = buildConfigFindings({
        ...HEALTHY,
        ruleIdentity: {
          ruleCount: 4,
          staleRuleCount: 3,
          staleAccountCount: 1,
          internalKeyRuleCount: 3,
          connectionKnown: true,
        },
      });
      expect(JSON.stringify(findings)).not.toContain("jirauser13506");
      expect(JSON.stringify(findings)).not.toContain("ugyildiz");
    });
  });

  it("puts problems first and green rows last", () => {
    const findings = buildConfigFindings({
      ...HEALTHY,
      deployment: { ...DC, workDriver: "not-configured", workDriverVariable: null },
    });
    const order = findings.map((finding) => finding.severity);
    expect([...order].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(order);
    expect(order[0]).toBe("sorun");
    expect(order[order.length - 1]).toBe("iyi");
  });
});

describe("GET /studio/config-health", () => {
  it("refuses a caller without an operator role", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);
    expect(
      (await h.app.inject({ method: "GET", url: "/studio/config-health", headers: auth(token) }))
        .statusCode,
    ).toBe(403);
  });

  /**
   * Kablolanmamış bir kurulumda 503 DEĞİL. Bir teşhis ekranının kendisi teşhis
   * edilemez hâle gelirse, kapattığı hata sınıfını yeniden açar.
   */
  it("answers 200 with 'unknown' rows on a deployment that reports nothing", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/config-health",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { state: string; findings: ConfigFinding[] };
    expect(body.findings.some((finding) => finding.id === "jira_driver")).toBe(true);
    expect(body.state).not.toBe("iyi");
  });

  it("reports the driver the composition root named, with no secret in the body", async () => {
    const h = await studioHarness({
      deps: {
        deploymentConfig: () => DC,
        commandIntakeStatus: () => ({
          mode: "both",
          pollSeconds: 60,
          canReadComments: true,
          appliesLive: true,
          source: "param",
        }),
        clarifyReentryStatus: () => Promise.resolve({ state: "open", source: "env" }),
        variantModelAudit: () => Promise.resolve({ scanned: 2, cloudModelVariants: [] }),
      },
    });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/config-health",
      headers: auth(token),
    });

    const body = response.json() as { findings: ConfigFinding[] };
    const driver = body.findings.find((finding) => finding.id === "jira_driver");
    expect(driver?.value).toBe("jira-dc");
    expect(driver?.detailParams).toEqual({ variable: "JIRA_BASE_URL" });
    expect(response.body).not.toMatch(/https?:\/\//);
  });

  /**
   * Bir okuyucunun FIRLATMASI bütün ekranı karartmaz: geri kalan altı satır
   * hâlâ okunabilir, ve fırlatan satır dürüstçe "bilinmiyor" der.
   */
  it("a reader that throws costs one row, not the whole screen", async () => {
    const h = await studioHarness({
      deps: {
        deploymentConfig: () => DC,
        variantModelAudit: () => Promise.reject(new Error("veritabanı takıldı")),
      },
    });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/config-health",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { findings: ConfigFinding[] };
    expect(body.findings.find((finding) => finding.id === "variant_models")?.value).toBe(
      "bilinmiyor",
    );
    expect(body.findings.find((finding) => finding.id === "jira_driver")?.value).toBe("jira-dc");
  });

  it("counts the status maps off the listening rules themselves", async () => {
    const h = await studioHarness({
      deps: { deploymentConfig: () => ({ ...DC, canMoveStatus: false }) },
      listeningRules: [
        {
          ruleId: "lr_1",
          projectKey: "UGURPAY",
          assigneeAccountId: "bot",
          matchKind: "assigned",
          matchValue: "*",
          flowType: "analiz",
          priority: 100,
          enabled: true,
          analystVariantId: null,
          engineerVariantId: null,
          statusMap: { onStart: "In Progress" },
        },
      ],
    });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/config-health",
      headers: auth(token),
    });

    const body = response.json() as { findings: ConfigFinding[] };
    // Eşleme yazılı ama sürücü taşıyamıyor: sessizce hiçbir şey yapmayan bir
    // ayar, ve bu ekranın var olma sebeplerinden biri.
    expect(body.findings.find((finding) => finding.id === "status_map")?.severity).toBe("sorun");
  });
});

/**
 * Panelden indirilen tanı raporu.
 *
 * Testlerin ikisi bir SINIRI kilitliyor (admin-only, kablosuz kurulumda
 * 503-by-name) ve biri bir CÜMLEYİ: raporun servis log'larını içermediğini
 * kendi içinde söylemesi. Üçüncüsü en önemlisi — yarım bir rapora bakıp "sorun
 * yok" demek, bu aracın kapatmaya geldiği hatanın ta kendisi.
 */
describe("GET /studio/tani", () => {
  const REPORT = { html: "<!doctype html><p>rapor</p>", fileName: "maestro-tani-20260830-1200.html" };

  it("is admin-only — a tech-lead who may READ the config table cannot download the report", async () => {
    const h = await studioHarness({ deps: { taniReport: () => Promise.resolve(REPORT) } });
    await h.addUser({ username: "lider", roles: ["tech-lead"], groups: [] });
    const token = await h.login("lider");

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/tani",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(403);
  });

  it("serves the report as a download with the server-chosen file name", async () => {
    const h = await studioHarness({ deps: { taniReport: () => Promise.resolve(REPORT) } });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/tani",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename="${REPORT.fileName}"`,
    );
    // Bir tanı raporu üretildiği anın fotoğrafıdır; ara bir vekilin onu
    // saklaması, aracın verebileceği en yanlış cevap.
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toBe(REPORT.html);
  });

  /**
   * Boş bir sayfa indirmek yerine ADIYLA reddediyor. Boş bir rapor, bu ekranın
   * kapattığı sessiz-yanlışın daha kötü hâli olurdu: operatör indirir, hiçbir
   * bulgu görmez, "sorun yok" der.
   */
  it("refuses by name rather than hand back an empty page when no builder is wired", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/tani",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(503);
    const body = response.json() as { details?: { capability?: string; missing?: string } };
    expect(body.details?.capability).toBe("tani");
    // Ve operatöre ne yapacağını söylüyor: betik hâlâ tam raporu üretir.
    expect(body.details?.missing).toMatch(/tani\.sh/);
  });
});

/**
 * KAPI ONAY GRUBU — ve neden bu satır KIRMIZI DEĞİL.
 *
 * Bazı kurumlarda onay grubu diye bir şey yoktur ve kararlar Jira statüsüyle
 * verilir; bu bir eksiklik değil, bir tercih. O operatöre her açılışta kırmızı
 * bir satır göstermek, ona uyarıları okumamayı öğretir — ve bu ekranın en
 * pahalıya patlayacak kaybı tam olarak budur.
 */
describe("kapı onay grubu satırı", () => {
  it("eşlenmişse yeşil", () => {
    const finding = row(buildConfigFindings(HEALTHY), "gate_groups");
    expect(finding.severity).toBe("iyi");
    expect(finding.value).toBe("eslenmis");
  });

  it("eşlenmemişse BİLGİ — uyarı ya da sorun DEĞİL", () => {
    const findings = buildConfigFindings({ ...HEALTHY, gateGroups: { configured: false } });
    const finding = row(findings, "gate_groups");
    expect(finding.severity).toBe("bilgi");
    expect(finding.value).toBe("eslenmemis");
    // Düzeltilecek bir şey yok: "çözüm" satırı, bilerek yapılmış bir tercihi
    // bir arıza gibi gösterirdi.
    expect(finding.fixKey).toBeNull();
  });

  it("eşlenmemiş olması genel durumu bozmaz", () => {
    const findings = buildConfigFindings({ ...HEALTHY, gateGroups: { configured: false } });
    // `bilgi` en kötü satır olsa bile ekran kırmızıya ya da sarıya dönmez.
    expect(worstSeverity(findings)).not.toBe("sorun");
    expect(worstSeverity(findings)).not.toBe("uyari");
  });

  it("okunamadıysa 'bilinmiyor' — 'eşlenmemiş' değil", () => {
    const finding = row(buildConfigFindings({ ...HEALTHY, gateGroups: null }), "gate_groups");
    expect(finding.value).not.toBe("eslenmemis");
  });
});
