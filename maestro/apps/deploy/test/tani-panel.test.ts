import { describe, expect, it } from "vitest";
import type { ConfigFinding } from "@maestro/bff";
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
