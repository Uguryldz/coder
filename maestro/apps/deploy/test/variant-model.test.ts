import { MODEL_NOT_SELECTED } from "@maestro/db";
import type { ResolvedModel } from "@maestro/llm-gateway";
import { describe, expect, it } from "vitest";
import { PrismaVariantModelReader } from "../src/stores/variant-model-reader.js";
import { variantAwareModelFrom } from "../src/stores/variant-model.js";

/**
 * `variantAwareModelFrom` — Studio'daki ajan tanımının modelini gerçek çağrıya
 * bağlayan katman.
 *
 * Sınanan iddia şu: bir çağrının hangi AJAN adına yapıldığı, hangi MODELİN
 * cevapladığını değiştirir. Değiştirmediği için operatör "modeller değişmiyor"
 * diyordu — `run.variantId` zincirde taşınıyor ama model seçimine hiç
 * dokunmuyordu.
 *
 * İkinci iddia da en az onun kadar önemli: ajan modeli UYGULANAMADIĞINDA bu
 * SESSİZ olmaz. Aşağıdaki testlerin yarısı uyarı satırını sınıyor, çünkü
 * "sessizce yanlış modele düşmek" tam olarak kapatılan hata.
 */

const PANEL: ResolvedModel = {
  baseUrl: "https://llm.banka.local",
  model: "panel-modeli",
  onPrem: true,
  apiKeyRef: "connector:llm-1:abc",
  skipTlsVerify: false,
};

/** Bir `VariantVersion` tablosu taklidi: varyant → (sürüm, model) satırları. */
function reader(rows: Record<string, { version: number; model: string }[]> | Error): PrismaVariantModelReader {
  return new PrismaVariantModelReader({
    findMany: ({ where }) => {
      if (rows instanceof Error) return Promise.reject(rows);
      const found = (rows[where.variantId] ?? []).slice().sort((a, b) => b.version - a.version);
      return Promise.resolve(found.map((r) => ({ ...r, configJson: {} })));
    },
  });
}

/** Uyarıları toplayan bir çözücü kurar; her testin ihtiyacı bu ikili. */
function build(
  rows: Record<string, { version: number; model: string }[]> | Error,
  base: ResolvedModel | null = PANEL,
): { resolve: (variantId?: string) => Promise<ResolvedModel | null>; warnings: string[] } {
  const warnings: string[] = [];
  const resolve = variantAwareModelFrom({
    base: () => Promise.resolve(base),
    variants: reader(rows),
    onWarn: (message) => warnings.push(message),
  });
  return { resolve, warnings };
}

describe("variantAwareModelFrom — ajanın modeli", () => {
  it("ajanın yayınlanmış modelini kullanır, bağlantı panelininkini değil", async () => {
    const { resolve } = build({ "analyst-kredi": [{ version: 1, model: "qwen-analiz" }] });

    const active = await resolve("analyst-kredi");

    expect(active?.model).toBe("qwen-analiz");
  });

  it("iki ajan iki farklı modele bağlanabilir — şikayetin ta kendisi", async () => {
    // Bankanın gerçek senaryosu: tek bir vLLM sunucusu, iki ajan, iki model.
    // Değişiklikten önce ikisi de `panel-modeli` alıyordu.
    const { resolve } = build({
      "analyst-kredi": [{ version: 1, model: "qwen-analiz" }],
      "engineer-kredi": [{ version: 1, model: "qwen-kod" }],
    });

    expect((await resolve("analyst-kredi"))?.model).toBe("qwen-analiz");
    expect((await resolve("engineer-kredi"))?.model).toBe("qwen-kod");
  });

  it("EN YENİ sürümün modelini alır — Studio'da yayınlanan sürüm canlıdır", async () => {
    const { resolve } = build({
      "analyst-kredi": [
        { version: 1, model: "eski-model" },
        { version: 3, model: "yeni-model" },
        { version: 2, model: "ara-model" },
      ],
    });

    expect((await resolve("analyst-kredi"))?.model).toBe("yeni-model");
  });

  it("ADRESİ, ANAHTARI, on-prem bayrağını ve TLS'i bağlantı satırından alır", async () => {
    // Varyant tablosunda bu alanlar YOK. Onları varyanttan uydurmak, `onPrem`'i
    // tahmin etmek demekti — M18 gizli-veri kuralı tam olarak ona dayanıyor.
    const { resolve } = build({ "analyst-kredi": [{ version: 1, model: "qwen-analiz" }] });

    const active = await resolve("analyst-kredi");

    expect(active).toEqual({ ...PANEL, model: "qwen-analiz" });
  });
});

describe("variantAwareModelFrom — düşüşler sessiz değil", () => {
  it("ajanın modeli yoksa panele düşer ve ajanı ADIYLA anan bir uyarı yazar", async () => {
    const { resolve, warnings } = build({});

    const active = await resolve("analyst-kredi");

    expect(active?.model).toBe("panel-modeli");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("analyst-kredi");
    expect(warnings[0]).toContain("Ajan tanımları");
  });

  it("model 'secilmedi' işaret değeriyse panele düşer ve işareti uyarıda anar", async () => {
    // Kurulumun plantladığı bootstrap değeri: bir bulut adı DEĞİL, operatörün
    // henüz seçmediğini söyleyen bir işaret. Uyarı onu adıyla söylemeli ki
    // operatör aradığı kelimeyi logda bulsun.
    const { resolve, warnings } = build({
      "analyst-default": [{ version: 1, model: MODEL_NOT_SELECTED }],
    });

    expect((await resolve("analyst-default"))?.model).toBe("panel-modeli");
    expect(warnings[0]).toContain(MODEL_NOT_SELECTED);
  });

  it("varyant okuması patlarsa çağrı düşmez, panele düşer — ama uyarır", async () => {
    // Postgres erişilemez. Bir ajan TERCİHİ uğruna, ortamın hâlâ
    // cevaplayabildiği bir çağrıyı düşürmek orantısız olurdu.
    const { resolve, warnings } = build(new Error("connection refused"));

    expect((await resolve("analyst-kredi"))?.model).toBe("panel-modeli");
    expect(warnings[0]).toContain("okunamadı");
    expect(warnings[0]).toContain("UYGULANMADI");
  });

  it("ajanın modeli paneldekinden farklıysa hangisinin kazandığını söyler", async () => {
    const { resolve, warnings } = build({ "analyst-kredi": [{ version: 1, model: "qwen-analiz" }] });

    await resolve("analyst-kredi");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("qwen-analiz");
    expect(warnings[0]).toContain("panel-modeli");
  });

  it("ajanın modeli panelinkiyle AYNIYSA söyleyecek bir şey yoktur", async () => {
    const { resolve, warnings } = build({ "analyst-kredi": [{ version: 1, model: "panel-modeli" }] });

    expect((await resolve("analyst-kredi"))?.model).toBe("panel-modeli");
    expect(warnings).toEqual([]);
  });

  it("aynı uyarıyı her çağrıda tekrarlamaz", async () => {
    // Bu yol her istekte çalışıyor; çağrı başına bir satır, söylemek istediği
    // şeyi gömerdi.
    const { resolve, warnings } = build({ "analyst-kredi": [{ version: 1, model: "qwen-analiz" }] });

    await resolve("analyst-kredi");
    await resolve("analyst-kredi");
    await resolve("analyst-kredi");

    expect(warnings).toHaveLength(1);
  });

  it("ajanın modeli var ama panelde adres yoksa null döner ve sebebi söyler", async () => {
    // Karar gateway'in statik katmanına geçer: `.env` bir uç adı veriyorsa
    // oradan, vermiyorsa `ModelNotConfiguredError` ile ADIYLA reddedilir.
    const { resolve, warnings } = build(
      { "analyst-kredi": [{ version: 1, model: "qwen-analiz" }] },
      null,
    );

    expect(await resolve("analyst-kredi")).toBeNull();
    expect(warnings[0]).toContain("model bağlantısı");
  });
});

describe("variantAwareModelFrom — varyantı olmayan çağrılar", () => {
  it("varyant verilmemişse taban çözücünün cevabı aynen geçer", async () => {
    const { resolve, warnings } = build({ "analyst-kredi": [{ version: 1, model: "qwen-analiz" }] });

    expect(await resolve()).toEqual(PANEL);
    expect(warnings).toEqual([]);
  });

  it("'*' bir varyant KİMLİĞİ değildir — tabloda aranmaz", async () => {
    // `AgentSessionOptions.variantId` sözleşmesi "`*` when the caller has none"
    // diyor. Onu aramak her seferinde boş dönecek bir sorgudur.
    let asked = false;
    const resolve = variantAwareModelFrom({
      base: () => Promise.resolve(PANEL),
      variants: new PrismaVariantModelReader({
        findMany: () => {
          asked = true;
          return Promise.resolve([]);
        },
      }),
      onWarn: () => {},
    });

    expect(await resolve("*")).toEqual(PANEL);
    expect(asked).toBe(false);
  });

  it("varyant deposu bağlı değilse tamamen taban çözücü gibi davranır", async () => {
    const resolve = variantAwareModelFrom({ base: () => Promise.resolve(PANEL) });

    expect(await resolve("analyst-kredi")).toEqual(PANEL);
  });

  it("varyant kimliğini taban çözücüye de geçirir", async () => {
    // Taban çözücü bugün onu kullanmıyor (`connectionModelFrom` argümansız
    // yazılmış), ama zincirin kopmaması bu katmanın işi: ileride bağlantı
    // seçimi de ajana bakarsa, bilgi oraya ULAŞIYOR olmalı.
    let seen: string | undefined = "hiç-çağrılmadı";
    const resolve = variantAwareModelFrom({
      base: (variantId) => {
        seen = variantId;
        return Promise.resolve(PANEL);
      },
      variants: reader({}),
      onWarn: () => {},
    });

    await resolve("analyst-kredi");

    expect(seen).toBe("analyst-kredi");
  });
});
