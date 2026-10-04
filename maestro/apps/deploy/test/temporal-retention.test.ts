import { describe, expect, it, vi } from "vitest";
import {
  insanOkunur,
  saklamaSuresiniAcilistaAyarla,
  saklamaSuresiniGuvence,
  saniyeyeCevir,
  VARSAYILAN_SAKLAMA,
  type NamespaceServisi,
} from "../src/temporal-retention.js";

const GUN = 86_400;
const DOKSAN_GUN = 90 * GUN; // 2160h

/**
 * Namespace servisi taklidi: mevcut süreyi tutar, `updateNamespace` çağrılarını
 * sayar. Sayaç asıl olan — İDEMPOTENSİN ölçüsü "yazdı mı", "sonuç doğru mu"
 * değil: bir açılışta gereksiz yazma yapan bir adım, on açılışta on tane yapar.
 */
function sahteServis(options: {
  mevcutSaniye?: number | null;
  describeHata?: Error;
  updateHata?: Error;
}): NamespaceServisi & { yazmalar: { seconds: number }[] } {
  const yazmalar: { seconds: number }[] = [];
  return {
    yazmalar,
    describeNamespace: (): Promise<{
      config?: { workflowExecutionRetentionTtl?: { seconds?: unknown } | null } | null;
    }> => {
      if (options.describeHata) return Promise.reject(options.describeHata);
      const saniye = options.mevcutSaniye;
      if (saniye === null || saniye === undefined) return Promise.resolve({ config: {} });
      return Promise.resolve({ config: { workflowExecutionRetentionTtl: { seconds: saniye } } });
    },
    updateNamespace: (request): Promise<unknown> => {
      if (options.updateHata) return Promise.reject(options.updateHata);
      yazmalar.push(request.config.workflowExecutionRetentionTtl);
      return Promise.resolve({});
    },
  };
}

describe("saniyeyeCevir", () => {
  it("compose ve install.sh'ın yazdığı biçimi anlar", () => {
    // Aynı metin üç yerde geçiyor; biri diğerini anlamazsa operatörün .env'de
    // değiştirdiği değer sessizce yok sayılırdı.
    expect(saniyeyeCevir("2160h")).toBe(DOKSAN_GUN);
    expect(saniyeyeCevir("90d")).toBe(DOKSAN_GUN);
    expect(saniyeyeCevir("24h")).toBe(GUN);
    expect(saniyeyeCevir(" 30m ")).toBe(1800);
  });

  it("tanınmayan ya da anlamsız değere null der", () => {
    for (const bozuk of ["", "iki bin", "2160", "0h", "-5h", "90y"]) {
      expect(saniyeyeCevir(bozuk)).toBeNull();
    }
  });
});

describe("insanOkunur", () => {
  it("kısa süreyi saatle, uzunu günle söyler", () => {
    expect(insanOkunur(GUN)).toBe("24 saat");
    expect(insanOkunur(DOKSAN_GUN)).toBe("90 gün");
  });
});

describe("saklamaSuresiniGuvence", () => {
  it("ölçülmüş arızayı düzeltir: 24 saat → 90 gün", async () => {
    const servis = sahteServis({ mevcutSaniye: GUN });
    const sonuc = await saklamaSuresiniGuvence(servis, "default", DOKSAN_GUN);
    expect(sonuc).toEqual({ durum: "guncellendi", oncekiSaniye: GUN, yeniSaniye: DOKSAN_GUN });
    expect(servis.yazmalar).toEqual([{ seconds: DOKSAN_GUN }]);
  });

  it("İDEMPOTENT: değer zaten yeterliyse hiçbir şey yazmaz", async () => {
    const servis = sahteServis({ mevcutSaniye: DOKSAN_GUN });
    const sonuc = await saklamaSuresiniGuvence(servis, "default", DOKSAN_GUN);
    expect(sonuc).toEqual({ durum: "zaten_yeterli", mevcutSaniye: DOKSAN_GUN });
    expect(servis.yazmalar).toEqual([]);
  });

  it("kurumun BİLEREK uzattığı süreyi geri çekmez", async () => {
    // 180 gün: bir denetim birimi uzatmış olabilir. "İstenen değere eşitle"
    // mantığı bunu her açılışta 90 güne kısaltırdı — yani bu dosyanın
    // önlemeye çalıştığı kaybın aynısını kendisi üretirdi.
    const servis = sahteServis({ mevcutSaniye: 180 * GUN });
    const sonuc = await saklamaSuresiniGuvence(servis, "default", DOKSAN_GUN);
    expect(sonuc.durum).toBe("zaten_yeterli");
    expect(servis.yazmalar).toEqual([]);
  });

  it("süre hiç okunamıyorsa yine de ayarlar", async () => {
    const servis = sahteServis({ mevcutSaniye: null });
    const sonuc = await saklamaSuresiniGuvence(servis, "default", DOKSAN_GUN);
    expect(sonuc).toEqual({ durum: "guncellendi", oncekiSaniye: null, yeniSaniye: DOKSAN_GUN });
  });

  it("FAIL-SOFT: okuma patlarsa fırlatmaz, sebebi söyler", async () => {
    const servis = sahteServis({ describeHata: new Error("temporal henüz hazır değil") });
    const sonuc = await saklamaSuresiniGuvence(servis, "default", DOKSAN_GUN);
    expect(sonuc).toEqual({ durum: "yapilamadi", sebep: "temporal henüz hazır değil" });
  });

  it("FAIL-SOFT: yazma yetkisi yoksa fırlatmaz", async () => {
    const servis = sahteServis({ mevcutSaniye: GUN, updateHata: new Error("PermissionDenied") });
    const sonuc = await saklamaSuresiniGuvence(servis, "default", DOKSAN_GUN);
    expect(sonuc).toEqual({ durum: "yapilamadi", sebep: "PermissionDenied" });
  });
});

describe("saklamaSuresiniAcilistaAyarla", () => {
  function log(): { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
    return { info: vi.fn(), warn: vi.fn() };
  }

  it("TEMPORAL_RETENTION verilmediğinde 90 güne ayarlar", async () => {
    const servis = sahteServis({ mevcutSaniye: GUN });
    const kayit = log();
    const sonuc = await saklamaSuresiniAcilistaAyarla({
      servis,
      namespace: "default",
      istenen: undefined,
      log: kayit,
    });
    expect(sonuc.durum).toBe("guncellendi");
    expect(servis.yazmalar).toEqual([{ seconds: DOKSAN_GUN }]);
    // Operatörün okuyacağı satır: ne olduğunu ADIYLA söylüyor.
    expect(String(kayit.info.mock.calls[0]?.[0])).toContain("24 saat → 90 gün");
  });

  it("operatörün .env'de verdiği değeri kullanır", async () => {
    const servis = sahteServis({ mevcutSaniye: GUN });
    await saklamaSuresiniAcilistaAyarla({
      servis,
      namespace: "default",
      istenen: "180d",
      log: log(),
    });
    expect(servis.yazmalar).toEqual([{ seconds: 180 * GUN }]);
  });

  it("bozuk TEMPORAL_RETENTION'ı UYARIR ve varsayılana düşer — 24 saatte bırakmaz", async () => {
    const servis = sahteServis({ mevcutSaniye: GUN });
    const kayit = log();
    await saklamaSuresiniAcilistaAyarla({
      servis,
      namespace: "default",
      istenen: "üç ay",
      log: kayit,
    });
    expect(String(kayit.warn.mock.calls[0]?.[0])).toContain("TEMPORAL_RETENTION okunamadı");
    expect(servis.yazmalar).toEqual([{ seconds: DOKSAN_GUN }]);
  });

  it("dokunmadığında da söyler", async () => {
    const kayit = log();
    await saklamaSuresiniAcilistaAyarla({
      servis: sahteServis({ mevcutSaniye: DOKSAN_GUN }),
      namespace: "default",
      log: kayit,
    });
    expect(String(kayit.info.mock.calls[0]?.[0])).toContain("zaten 90 gün");
  });

  it("ayarlayamadığında elle düzeltme komutunu yazar ve fırlatmaz", async () => {
    const kayit = log();
    const sonuc = await saklamaSuresiniAcilistaAyarla({
      servis: sahteServis({ describeHata: new Error("unavailable") }),
      namespace: "maestro",
      log: kayit,
    });
    expect(sonuc.durum).toBe("yapilamadi");
    const satir = String(kayit.warn.mock.calls[0]?.[0]);
    expect(satir).toContain("AYARLANAMADI");
    expect(satir).toContain("--namespace maestro");
    expect(satir).toContain(VARSAYILAN_SAKLAMA);
  });
});
