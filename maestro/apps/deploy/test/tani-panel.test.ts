import { describe, expect, it } from "vitest";
import type { ConfigFinding } from "@maestro/bff";
import type { KosuSatiri } from "../src/tani.js";
import {
  bulgulara,
  logsuzBolum,
  panelTaniRaporu,
  taniDosyaAdi,
  type AkisKaynagi,
} from "../src/tani-panel.js";

/**
 * Panelden indirilen tanı raporu.
 *
 * Bu dosyanın en önemli testi `logsuzBolum` üzerine olanı: raporun EKSİK
 * olduğunu kendi içinde söylemesi. Sessizce boş bir 4. bölüm, `taniHtml`
 * tarafında "toplanan log'larda hata bulunmadı" diye render edilirdi — hiç log
 * toplanmamışken. Yarım rapora bakıp "sorun yok" demek, bu aracın kapatmaya
 * geldiği hatanın ta kendisi.
 */

const AKIS: AkisKaynagi = {
  toplam: () => Promise.resolve(7),
  adimDagilimi: () => Promise.resolve([["2b", 3] as const]),
  netlestirmeBekleyen: () => Promise.resolve([]),
  sonKosular: () => Promise.resolve([]),
  temporalAcik: () => Promise.resolve(2),
  bekleyenKosular: () => Promise.resolve([]),
  acikTicketlar: () => Promise.resolve(new Set<string>()),
  saklamaSaniye: () => Promise.resolve(90 * 86_400),
};

const FINDING: ConfigFinding = {
  id: "jira_driver",
  severity: "iyi",
  value: "jira-dc",
  detailKey: "config.detail.jira_driver.chosen",
  detailParams: { variable: "JIRA_BASE_URL" },
  fixKey: null,
};

function options(overrides: Partial<Parameters<typeof panelTaniRaporu>[0]> = {}) {
  return {
    config: () =>
      Promise.resolve({
        deployment: null,
        intake: null,
        clarify: null,
        variants: null,
        statusMaps: null,
        ruleIdentity: null,
    gateGroups: null,
      }),
    akis: AKIS,
    hostAdi: "banka-01",
    imajSurumu: "1.0.15",
    now: () => new Date("2026-08-30T12:34:56Z"),
    ...overrides,
  };
}

describe("taniDosyaAdi", () => {
  it("is sortable, collision-free and readable", () => {
    // Yerel saat kullanılıyor (operatörün sunucusunun saati), o yüzden yalnız
    // biçim kilitleniyor — sabit bir saat beklemek testi zaman dilimine bağlardı.
    expect(taniDosyaAdi(new Date("2026-08-30T12:34:56Z"))).toMatch(
      /^maestro-tani-\d{8}-\d{4}\.html$/,
    );
  });
});

describe("logsuzBolum", () => {
  /**
   * Bölümün VAR olması şart. Boş bir `servisler` dizisi, sayfanın 4. bölümünü
   * "hata/uyarı kalıbı eşleşmedi" cümlesine düşürürdü — yani toplanmış
   * log'larda sorun bulunmadığını söylerdi, oysa hiç log toplanmamıştır.
   */
  it("states the absence as a named reason rather than rendering an empty section", () => {
    const bolum = logsuzBolum();

    expect(bolum.servisler).toHaveLength(1);
    expect(bolum.servisler[0]?.hata).toBeDefined();
    expect(bolum.servisler[0]?.hata).toMatch(/tani\.sh/);
    expect(bolum.servisler[0]?.hata).toMatch(/İÇERMEZ/);
  });
});

describe("bulgulara", () => {
  it("renders the SAME sentences the panel shows, from the same catalog", () => {
    const [bulgu] = bulgulara([FINDING]);

    expect(bulgu?.baslik).toBe("Jira sürücüsü");
    expect(bulgu?.sonuc).toContain("Jira Data Center");
    // Değişkenin ADI geçiyor, adresi değil.
    expect(bulgu?.sonuc).toContain("JIRA_BASE_URL");
  });

  /**
   * `bilgi` → `bilinmiyor`, `uyari`ya DEĞİL. Kapalı ağda webhook sırrının
   * olmayışını uyarıya çıkarmak, raporu her DC kurulumunda sarıya boyardı.
   */
  it("maps a note to 'bilinmiyor' so a deliberate absence is not an alarm", () => {
    const [bulgu] = bulgulara([{ ...FINDING, severity: "bilgi", value: "tanimsiz" }]);
    expect(bulgu?.seviye).toBe("bilinmiyor");
  });

  it("carries the fix only when there is one", () => {
    const [yesil] = bulgulara([FINDING]);
    expect(yesil?.cozum).toBeUndefined();

    const [kirmizi] = bulgulara([
      { ...FINDING, severity: "sorun", fixKey: "config.fix.jira_driver.none" },
    ]);
    expect(kirmizi?.seviye).toBe("kritik");
    expect(kirmizi?.cozum).toMatch(/YALNIZCA BİRİNİ/);
  });

  it("shows the key itself rather than dropping the report when a key is missing", () => {
    const [bulgu] = bulgulara([{ ...FINDING, detailKey: "config.detail.hic.olmayan.anahtar" }]);
    expect(bulgu?.sonuc).toContain("config.detail.hic.olmayan.anahtar");
  });
});

describe("panelTaniRaporu", () => {
  it("produces a page that names its own missing section", async () => {
    const report = await panelTaniRaporu(options());

    expect(report.html).toContain("<!doctype html>");
    expect(report.html).toContain("4 · Servis log");
    // Eksiklik sayfanın İÇİNDE, log'ların olması gereken yerin tam kendisinde.
    expect(report.html).toMatch(/log alınamadı/);
    expect(report.html).toMatch(/tani\.sh/);
    expect(report.fileName).toMatch(/^maestro-tani-/);
  });

  /**
   * Canlı Jira testi panelde atlanıyor ve sebebi yazılıyor. Sessizce boş bir
   * 3. bölüm, "Jira testleri geçti" diye okunabilirdi.
   */
  it("says WHY the live Jira section is skipped instead of leaving it blank", async () => {
    const report = await panelTaniRaporu(options());
    expect(report.html).toMatch(/Canlı Jira testi panel raporunda ATLANIR/);
  });

  it("survives a flow read that throws — one section degrades, the page does not", async () => {
    const report = await panelTaniRaporu(
      options({
        akis: {
          ...AKIS,
          toplam: () => Promise.reject(new Error("veritabanı takıldı")),
          temporalAcik: () => Promise.reject(new Error("temporal yok")),
        },
      }),
    );

    expect(report.html).toContain("<!doctype html>");
    expect(report.html).toMatch(/Temporal okunamadı/);
  });

  /**
   * Bir bağlantı hata metninde DSN geçebilir, ve o metin doğrudan sayfaya
   * yazılıyor — maskeden geçmesi bu yüzden şart.
   */
  it("masks credentials out of an error message before it reaches the page", async () => {
    const report = await panelTaniRaporu(
      options({
        akis: {
          ...AKIS,
          temporalAcik: () =>
            Promise.reject(new Error("connect failed: postgres://kullanici:parola@db:5432/maestro")),
        },
      }),
    );

    expect(report.html).not.toContain("parola");
  });
});

/**
 * KAYIP KOŞULAR — ölçülmüş veri kaybının rapordaki sesi.
 *
 * Bu kurulumda `WorkflowRun` 14 koşuyu "running" gösterirken Temporal'da yalnız
 * 2 açık execution vardı; aradaki 12 koşu 4. ve 5. KAPIDA insan onayı bekliyor
 * ve 3.5-14 gün yaşındaydı. `tctl workflow describe` onlara "workflow not
 * found" diyordu. Sebep Temporal'ın varsayılan 24 saatlik saklama süresi, ve bu
 * ürünün akışı GÜNLER sürer (M61: kapılar SÜRESİZ bekler).
 *
 * Kaybın dışarıdan hiçbir belirtisi yok: panel "running" der, ticket kapıda
 * durur, `/approve` yazan operatör cevap alamaz. Bu satır, o sessizliğin tek
 * sesi.
 */
describe("kayıp koşular", () => {
  const KOSU = (ticketKey: string): KosuSatiri => ({
    id: `run-${ticketKey}`,
    ticketKey,
    step: "4",
    status: "running",
    updatedAt: "2026-08-28 09:00:00",
  });

  it("veritabanında bekleyip Temporal'da olmayan koşuyu ADIYLA sayar", async () => {
    const report = await panelTaniRaporu(
      options({
        akis: {
          ...AKIS,
          bekleyenKosular: () => Promise.resolve([KOSU("OPS-42"), KOSU("OPS-80")]),
          acikTicketlar: () => Promise.resolve(new Set(["OPS-80"])),
        },
      }),
    );

    // Kayıp koşu ADIYLA sayfada — bir sayı değil, operatörün açıp bakacağı
    // ticket'ın kendisi.
    expect(report.html).toContain("OPS-42");
    expect(report.html).toContain("execution'ı YOK");
    // Ve ne yapacağı: saklama süresini artıran komut.
    expect(report.html).toContain("namespace update --retention");
    // Temporal'da olanı kayıp SAYMAZ.
    expect(report.html).toMatch(/<b>1<\/b> koşu veritabanında/u);
  });

  it("hepsi Temporal'da varsa kayıp İDDİA ETMEZ", async () => {
    const report = await panelTaniRaporu(
      options({
        akis: {
          ...AKIS,
          bekleyenKosular: () => Promise.resolve([KOSU("OPS-80")]),
          acikTicketlar: () => Promise.resolve(new Set(["OPS-80"])),
        },
      }),
    );
    expect(report.html).toContain("Bekleyen her koşunun Temporal'da bir execution'ı var");
    expect(report.html).not.toContain("execution'ı YOK");
  });

  /**
   * "Kayıp yok" ile "kıyas yapılamadı" AYRI cevaplar. İkincisini birincisi gibi
   * göstermek, ölçülmemiş bir şeyi sağlıklı ilan etmek olurdu — bu aracın
   * kapatmaya geldiği hatanın ta kendisi.
   */
  it("Temporal okunamadıysa 'kayıp yok' DEMEZ", async () => {
    const report = await panelTaniRaporu(
      options({
        akis: {
          ...AKIS,
          bekleyenKosular: () => Promise.resolve([KOSU("OPS-42")]),
          acikTicketlar: () => Promise.reject(new Error("temporal yok")),
        },
      }),
    );
    expect(report.html).toContain("kıyası yapılamadı");
    expect(report.html).toContain('"kayıp yok" DEĞİL');
    // "Kayıp yok" cümlesini ASLA kurmaz: ölçülmemiş bir şeyi sağlıklı ilan
    // etmek, bu aracın kapatmaya geldiği hatanın ta kendisi.
    expect(report.html).not.toContain("Bekleyen her koşunun Temporal");
  });

  it("saklama süresini raporlar — kaybın sebebi neredeyse her zaman odur", async () => {
    const report = await panelTaniRaporu(options({ akis: AKIS }));
    expect(report.html).toContain("Saklama süresi");
    expect(report.html).toContain("90 gün");
    // Yeterli süre SESSİZ: her raporda uyarı basmak uyarıyı değersizleştirir.
    expect(report.html).not.toContain("bu ürünün akışı için <b>KISA</b>");
  });

  /**
   * Süre YETMİYORSA rapor bunu söylemek zorunda. Ölçülen arıza tam buydu:
   * namespace 24 saatteydi, 12 koşu kapıda kayboldu, ve hiçbir ekran
   * "bu süre kısa" demiyordu — süre yazılıyordu ama kıyaslanmıyordu.
   */
  it("saklama süresi akışın altındaysa UYARIR", async () => {
    const report = await panelTaniRaporu(
      options({ akis: { ...AKIS, saklamaSaniye: () => Promise.resolve(86_400) } }),
    );
    expect(report.html).toContain("24 saat");
    expect(report.html).toContain("bu ürünün akışı için <b>KISA</b>");
    // Ve ne yapılacağını: yeni imaj bunu kendisi ayarlıyor.
    expect(report.html).toContain("her worker açılışında kendisi");
  });
});
