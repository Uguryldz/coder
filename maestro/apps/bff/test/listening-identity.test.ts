import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { identityDrift, looksLikeDcInternalKey } from "../src/listening-identity.js";
import type { ListeningRuleRecord } from "../src/listening-store.js";
import { auth, harness, type Harness, type HarnessOptions } from "./helpers.js";

/**
 * KURALLARIN BOT KİMLİĞİ — kuralların taşıdığı kopya ile bağlantının bildiği
 * gerçek arasındaki fark, ve onu kapatan düğme.
 *
 * ── ÖLÇÜLEN ARIZA ───────────────────────────────────────────────────────────
 * Jira Data Center `/myself` cevabında bir kullanıcıyı İKİ alanla adlandırır:
 * `name` ("ugyildiz", operatörün gördüğü kullanıcı adı) ve `key`
 * ("jirauser13506", iç tutamak). Bağlantı yoklaması `key`i okuyordu, o değer
 * dinleme kurallarının `assigneeAccountId` alanına tohumlandı, ve tarama onu
 * doğrudan JQL'e yapıştırıyor.
 *
 * JQL `assignee`yi KULLANICI ADIYLA çözer. İç tutamakla yazılan sorgu hiçbir
 * şeyle eşleşmez — ve Jira buna hata değil 200 + BOŞ sayfa cevabı verir. Yani
 * atanmış ticket'larla dolu bir projede her tur "0 sonuç" diyordu, her ekran
 * yeşildi, ve hiçbir yerde nedeni yazmıyordu. Sahada doğrulandı: atama kullanıcı
 * adıyla sorulunca ticket'lar geldi.
 *
 * ── NEDEN MİGRATION DEĞİL, DÜĞME ────────────────────────────────────────────
 * `connection-service.ts` düzeltildi ve bağlantı testi `config.botAccountId`i
 * doğru değere çekiyor. Ama MEVCUT kurallar kendi kopyalarını taşıyor. Bir SQL
 * migration'ı onları düzeltemezdi: doğru değer hesaplanamaz (tek kaynağı
 * Jira'nın `/myself` cevabı, yani bir AĞ çağrısı), `jirauser` deseni bir
 * TAHMİNdir (bazı DC kurulumlarında `key` gerçekten kullanıcı adına eşittir), ve
 * bir kuralın hangi ticket'ları aldığını operatör bakmıyorken değiştirmek
 * düzeltmeye çalıştığımız sessiz-yanlışın ters yönde tekrarı olurdu.
 *
 * Onun yerine operatörün BASTIĞI bir düğme, ve bastığında ne olduğunu GÖREN bir
 * cevap. Aşağıdaki testler tam olarak bunu çiviliyor.
 */

/** Bankanın kurulumundaki iki değer — arızanın iki yüzü. */
const USERNAME = "ugyildiz";
const INTERNAL_KEY = "jirauser13506";

function rule(over: Partial<ListeningRuleRecord> = {}): ListeningRuleRecord {
  return {
    ruleId: "lr_1",
    projectKey: "OPS",
    assigneeAccountId: INTERNAL_KEY,
    matchKind: "issuetype",
    matchValue: "Hata",
    flowType: "duzeltme",
    priority: 100,
    enabled: true,
    analystVariantId: null,
    engineerVariantId: null,
    statusMap: null,
    allowedStatuses: null,
    ...over,
  } as ListeningRuleRecord;
}

describe("looksLikeDcInternalKey", () => {
  it("DC iç tutamağını tanır", () => {
    expect(looksLikeDcInternalKey(INTERNAL_KEY)).toBe(true);
    expect(looksLikeDcInternalKey("JIRAUSER42")).toBe(true);
  });

  /**
   * Kullanıcı adı da, Cloud'un accountId'si de bu desene UYMAZ — desen bir
   * yazmayı hiç yönlendirmiyor olsa bile, yanlış yerde uyarı çıkarmak bu
   * ekranın kırmızısına olan güveni bitirirdi.
   */
  it("kullanıcı adını ve Cloud hesap kimliğini iç tutamak SANMAZ", () => {
    expect(looksLikeDcInternalKey(USERNAME)).toBe(false);
    expect(looksLikeDcInternalKey("712020:b836c135-c9d3-499a-a665-aed43d362cfd")).toBe(false);
    // Sayıyla bitmeyen bir `jirauser` öneki: bir kullanıcının adı gerçekten
    // "jirauserugur" olabilir ve o bir iç tutamak değildir.
    expect(looksLikeDcInternalKey("jirauserugur")).toBe(false);
  });
});

describe("identityDrift", () => {
  it("bağlantının bildiğinden farklı kimlik taşıyan kuralları sayar", () => {
    const drift = identityDrift(
      [
        rule({ ruleId: "lr_1", assigneeAccountId: INTERNAL_KEY }),
        rule({ ruleId: "lr_2", assigneeAccountId: INTERNAL_KEY, matchValue: "Görev" }),
        rule({ ruleId: "lr_3", assigneeAccountId: USERNAME, matchValue: "Hikaye" }),
      ],
      USERNAME,
    );

    expect(drift.staleRuleCount).toBe(2);
    expect(drift.staleAccountIds).toEqual([{ accountId: INTERNAL_KEY, ruleCount: 2 }]);
    expect(drift.internalKeyRuleCount).toBe(2);
  });

  /**
   * BAĞLANTI BİLİNMİYORSA FARK İDDİA EDİLMEZ.
   *
   * "Bilmiyoruz" ile "ayrışık" arasındaki ayrım bu satırın inanılır kalmasının
   * şartı: hiç test edilmemiş bir bağlantının yanında kuralları ayrışık ilan
   * etmek, operatörü olmayan bir arızayı düzeltmeye gönderirdi. Desen sayımı
   * yine de yapılır — o, bağlantıdan bağımsız tek işaret.
   */
  it("bağlantı kimliği bilinmiyorken ayrışma İDDİA ETMEZ, ama deseni yine sayar", () => {
    const drift = identityDrift([rule(), rule({ ruleId: "lr_2", matchValue: "Görev" })], null);

    expect(drift.connectionAccountId).toBeNull();
    expect(drift.staleRuleCount).toBe(0);
    expect(drift.staleAccountIds).toEqual([]);
    // Kıyas yapılamadı ama desen hâlâ görülüyor — bankadaki durumun ta kendisi.
    expect(drift.internalKeyRuleCount).toBe(2);
  });

  /**
   * BANKADAKİ GERÇEK DURUM: iki katman da `key`i okuduğu için bağlantı ile
   * kurallar HEMFİKİRdi — ayrışma yoktu, arıza vardı. Kıyas tek başına bu hâli
   * yakalayamaz; deseni ayrı bir işaret olarak tutmanın sebebi tam olarak bu.
   */
  it("bağlantı da aynı iç kimliği taşıyorsa ayrışma yok — ama desen hâlâ görünür", () => {
    const drift = identityDrift([rule(), rule({ ruleId: "lr_2", matchValue: "Görev" })], INTERNAL_KEY);

    expect(drift.staleRuleCount).toBe(0);
    expect(drift.internalKeyRuleCount).toBe(2);
  });

  it("kimlikleri en çok kuralda geçenden başlayarak, kararlı sırayla verir", () => {
    const drift = identityDrift(
      [
        rule({ ruleId: "lr_1", assigneeAccountId: "eski-b" }),
        rule({ ruleId: "lr_2", assigneeAccountId: "eski-a", matchValue: "Görev" }),
        rule({ ruleId: "lr_3", assigneeAccountId: "eski-a", matchValue: "Hikaye" }),
      ],
      USERNAME,
    );
    expect(drift.staleAccountIds.map((entry) => entry.accountId)).toEqual(["eski-a", "eski-b"]);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

const JIRA_DC = {
  id: "jira",
  kind: "jira_dc" as const,
  displayName: "Jira Data Center",
  baseUrl: "https://jira.ugurbank.local",
  authKind: "bearer" as const,
  config: { botAccountId: USERNAME },
  secretRef: "connector:jira:1",
  secretMask: "z789",
  enabled: true,
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
  lastTestedAt: null,
  lastTestOk: null,
  lastTestNote: null,
  onPrem: true,
  isDefault: false,
};

async function admin(h: Harness): Promise<string> {
  await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
  return h.login("ayse.kaya");
}

function realign(h: Harness, token: string): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method: "POST",
    url: "/studio/listening-rules/realign-bot",
    headers: auth(token),
  });
}

/** Bozuk kimlikle yazılmış kuralları taşıyan bir kurulum — arızanın ertesi günü. */
async function driftedHarness(options: HarnessOptions = {}): Promise<Harness> {
  const h = await harness({ managedConnections: [JIRA_DC], ...options });
  await h.listening.put(rule({ ruleId: "lr_1", matchValue: "Hata" }));
  await h.listening.put(rule({ ruleId: "lr_2", matchValue: "Görev" }));
  return h;
}

describe("POST /studio/listening-rules/realign-bot", () => {
  it("kuralların bot hesabını bağlantının öğrendiği kimliğe taşır", async () => {
    const h = await driftedHarness();
    const token = await admin(h);

    const res = await realign(h, token);
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      accountId: string;
      changed: readonly { ruleId: string; from: string }[];
      untouched: number;
    };
    expect(body.accountId).toBe(USERNAME);
    expect(body.changed).toHaveLength(2);
    // NEREDEN nereye — sessiz bir düzeltme, hiç olmamış gibi okunurdu.
    expect(body.changed.every((entry) => entry.from === INTERNAL_KEY)).toBe(true);

    const stored = await h.listening.list();
    expect(stored.every((r) => r.assigneeAccountId === USERNAME)).toBe(true);
  });

  /**
   * KURALIN GERİ KALANI DOKUNULMADAN KALIR.
   *
   * Hizalama TEK bir alanı değiştirir. Akışı, statü eşlemesini ya da ajan
   * varyantını da sıfırlayan bir "düzeltme", operatörün elle kurduğu her şeyi
   * götürürdü — ve bunu, kimlik düzeliyor diye kimse fark etmeden yapardı.
   */
  it("yalnız bot hesabını değiştirir, kuralın geri kalanını ELLEMEZ", async () => {
    const h = await harness({ managedConnections: [JIRA_DC] });
    await h.listening.put(
      rule({
        ruleId: "lr_1",
        flowType: "gelistirme",
        priority: 42,
        enabled: false,
        allowedStatuses: ["Yapılacak"],
      }),
    );
    const token = await admin(h);
    await realign(h, token);

    const [stored] = await h.listening.list();
    expect(stored?.assigneeAccountId).toBe(USERNAME);
    expect(stored?.flowType).toBe("gelistirme");
    expect(stored?.priority).toBe(42);
    expect(stored?.enabled).toBe(false);
    expect(stored?.allowedStatuses).toEqual(["Yapılacak"]);
  });

  /** İDEMPOTENT: ikinci basış hiçbir şeyi değiştirmez ve bunu söyler. */
  it("zaten hizalı kurallara dokunmaz — ikinci basış boş döner", async () => {
    const h = await driftedHarness();
    const token = await admin(h);
    await realign(h, token);

    const again = (await realign(h, token)).json() as {
      changed: readonly unknown[];
      untouched: number;
    };
    expect(again.changed).toHaveLength(0);
    expect(again.untouched).toBe(2);
  });

  /**
   * BAĞLANTI TEST EDİLMEMİŞSE YAZMAZ.
   *
   * Yazılacak bir gerçek yokken bir şey uydurmak, düzeltmeye çalıştığımız
   * arızanın aynısını üretirdi — ve cevap operatörü yapması gereken şeye
   * (bağlantı testi) gönderiyor.
   */
  it("hiçbir bağlantı bot hesabı bilmiyorsa adıyla reddeder ve HİÇBİR kurala dokunmaz", async () => {
    const h = await driftedHarness({ managedConnections: [{ ...JIRA_DC, config: {} }] });
    const token = await admin(h);

    const res = await realign(h, token);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe("bot_account_unknown");

    const stored = await h.listening.list();
    expect(stored.every((r) => r.assigneeAccountId === INTERNAL_KEY)).toBe(true);
  });

  /**
   * DENETİM İZİ. Bir dinleme kuralının hangi ticket'ları aldığını değiştirmek
   * yapılandırma değişikliğidir, ve "hangi değerden hangisine" olmadan kayıt
   * sorulan soruyu cevaplamıyor.
   */
  it("değişikliği denetime yazar — hangi kimlikten hangisine, kaç kural", async () => {
    const h = await driftedHarness();
    const token = await admin(h);
    await realign(h, token);

    const entry = (await h.auditStore.read()).find(
      (row) => (row.meta as Record<string, unknown> | undefined)?.["verb"] === "bot_realigned",
    );
    expect(entry).toBeDefined();
    const meta = entry?.meta as Record<string, unknown>;
    expect(meta["accountIdNow"]).toBe(USERNAME);
    expect(meta["accountIdsWas"]).toBe(INTERNAL_KEY);
    expect(meta["ruleCount"]).toBe(2);
  });

  /** Hiçbir şey değişmediyse denetimde bir yapılandırma değişikliği görünmemeli. */
  it("hiçbir kural değişmediyse denetime yazmaz", async () => {
    const h = await harness({ managedConnections: [JIRA_DC] });
    await h.listening.put(rule({ assigneeAccountId: USERNAME }));
    const token = await admin(h);
    await realign(h, token);

    const entries = (await h.auditStore.read()).filter(
      (row) => (row.meta as Record<string, unknown> | undefined)?.["verb"] === "bot_realigned",
    );
    expect(entries).toHaveLength(0);
  });

  it("kural yazamayan bir çağıranı reddeder", async () => {
    const h = await driftedHarness();
    await h.addUser({ username: "mehmet.demir", roles: ["tech-lead"] });
    expect((await realign(h, await h.login("mehmet.demir"))).statusCode).toBe(403);
    await h.addUser({ username: "can.yilmaz", roles: ["developer"] });
    expect((await realign(h, await h.login("can.yilmaz"))).statusCode).toBe(403);
  });
});
