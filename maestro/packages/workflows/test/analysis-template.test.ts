import type { LlmCallLog } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { fanOutChildren, writeAnalysis } from "../src/impl/analysis.js";
import { ANALYSIS_FIELDS, analysisInstructions, analysisRules, sectionTitlesOf } from "../src/impl/analysis-template.js";
import { runContext } from "./doubles.js";
import { makeFakes } from "./fakes.js";
import { analysisDoc, finishedDoc } from "./harness.js";

/**
 * Üretim analisti Studio şablonunu görüyor ve deposuz koşuda etki matrisi
 * artık dürüstçe doldurulabiliyor.
 *
 * İki şikâyetin ikisi de buradan: "2. adım etki matrisinde hata düzeltiyor da
 * takılı kalmış" — deposuz koşuda şema `appId` için kayıt biçimi ve depo
 * kaynağı dayatıyordu, gpt-oss beş turda da tutturamıyordu. Ve "Studio
 * şablonu motora bağlı" iddiası pilotta doğru, Temporal'da yalandı: analist
 * yalnız JSON şeması görüyordu.
 */

const LOG: LlmCallLog = {
  at: "2026-09-05T09:00:00+03:00",
  runId: null,
  role: "analyst",
  variantId: "v1",
  driver: "openai-compat",
  model: "fake",
  tokensIn: 0,
  tokensOut: 0,
  cachePct: null,
  usd: null,
  dataClass: "dahili",
};
const TEMPLATE = [
  { key: "amac_ve_is_degeri", title: "Amaç ve iş değeri", aiInstruction: "Tanımı yaz." },
  { key: "kapsam_dahil_haric", title: "Kapsam (dahil / hariç)", aiInstruction: "İki liste." },
  { key: "etki_analizi", title: "Etki analizi", aiInstruction: "Her uygulama için karar ver." },
  { key: "kabul_kriterleri", title: "Kabul kriterleri", aiInstruction: "Doğrulanabilir maddeler." },
  { key: "ekran_ve_api_degisiklikleri", title: "Ekran ve API değişiklikleri", aiInstruction: "Yüzeyleri yaz." },
  { key: "test_yaklasimi", title: "Test yaklaşımı", aiInstruction: "Piramit." },
  { key: "risk_ve_geri_donus_plani", title: "Risk ve geri dönüş planı", aiInstruction: "Risk, önlem, geri dönüş." },
  { key: "kaynaklar", title: "Kaynaklar", aiInstruction: "Her iddiaya kaynak." },
  { key: "netlestirilecek_acik_maddeler", title: "Netleştirilecek açık maddeler", aiInstruction: "Açık kalanlar." },
];

function analysisInput(fakes: ReturnType<typeof makeFakes>): Record<string, unknown> {
  return fakes.recorded.llm.find((c) => c.schemaName === "analysis-doc")?.input as Record<string, unknown>;
}

describe("analysisInstructions", () => {
  it("şablon bölümlerini belgenin yedi alanına SIRAYLA eşler; fazlasını uyararak atlar", async () => {
    const warnings: string[] = [];
    const { deps } = makeFakes({ analysisTemplate: TEMPLATE });
    const out = await analysisInstructions(deps, runContext(), (m) => warnings.push(m));
    expect(out?.map((s) => s.field)).toEqual([...ANALYSIS_FIELDS]);
    expect(out?.[2]).toEqual({ field: "impactMatrix", title: "Etki analizi", instruction: "Her uygulama için karar ver." });
    expect(warnings[0]).toMatch(/fazla bölümler uygulanmadı: Kaynaklar, Netleştirilecek açık maddeler/);
    expect(sectionTitlesOf(out)).toMatchObject({ purpose: "Amaç ve iş değeri", riskAndRollback: "Risk ve geri dönüş planı" });
  });

  it("seam yoksa / sürüm yoksa / okuma patlarsa null döner — analist şemayla çalışır", async () => {
    expect(await analysisInstructions(makeFakes().deps, runContext())).toBeNull();
    expect(await analysisInstructions(makeFakes({ analysisTemplate: null }).deps, runContext(), () => undefined)).toBeNull();
    const warnings: string[] = [];
    expect(
      await analysisInstructions(makeFakes({ analysisTemplate: new Error("pg down") }).deps, runContext(), (m) => warnings.push(m)),
    ).toBeNull();
    expect(warnings[0]).toMatch(/okunamadı/);
  });
});

describe("analysisRules", () => {
  it("deposuz koşuda etki matrisi için 'ticket' kaynağını ve boş listeyi meşru kılar; depolu koşuda en az bir satır ister", () => {
    const noRepo = analysisRules({ ...runContext(), app: null });
    expect(noRepo.join("\n")).toMatch(/kod deposu YOK[\s\S]*'ticket'[\s\S]*boş bırak/);
    expect(noRepo.join("\n")).toContain("'tr'");
    const withRepo = analysisRules(runContext());
    expect(withRepo.join("\n")).toMatch(/en az bir satır zorunlu/);
  });
});

describe("writeAnalysis", () => {
  it("kurallar ve şablon talimatları input'ta persona/guidance'tan sonra, talepten önce gider", async () => {
    const fakes = makeFakes({
      persona: { v1: "Analistsin." },
      analysisTemplate: TEMPLATE,
      generateObject: () => ({ status: "ok" as const, value: analysisDoc("orta"), log: LOG }),
    });
    await writeAnalysis(fakes.deps, "PAY-101", "pay");
    const input = analysisInput(fakes);
    const keys = Object.keys(input);
    expect(keys.slice(0, 4)).toEqual(["persona", "rules", "template", "appId"]);
    expect((input["template"] as unknown[]).length).toBe(7);
    expect((input["rules"] as string[]).some((r) => r.includes("templateVersion"))).toBe(true);
  });

  it("deposuz koşuda BOŞ etki matrisi kabul edilir; depolu koşuda reddedilir", async () => {
    const empty = { ...analysisDoc("dusuk"), impactMatrix: [] };
    const noRepo = makeFakes({
      context: { app: null },
      generateObject: () => ({ status: "ok" as const, value: empty, log: LOG }),
    });
    await expect(writeAnalysis(noRepo.deps, "PAY-101")).resolves.toMatchObject({ risk: "dusuk" });

    const withRepo = makeFakes({ generateObject: () => ({ status: "ok" as const, value: empty, log: LOG }) });
    await expect(writeAnalysis(withRepo.deps, "PAY-101", "pay")).rejects.toThrow(/names no impacted application/);
  });
});

describe("fanOutChildren", () => {
  it("'ticket' kaynaklı ya da kayıt biçiminde olmayan bir hücre için alt ticket AÇMAZ", async () => {
    const fakes = makeFakes({ context: { app: null } });
    const doc = {
      ...finishedDoc("orta"),
      impactMatrix: [
        { appId: "BOA", impacted: true, summary: "rapor ekranı", source: "ticket" as const },
        { appId: "kredi-tahsis", impacted: true, summary: "limit", source: "ticket" as const },
        { appId: "ugurpay-core", impacted: true, summary: "limit servisi", source: "repo_card" as const },
      ],
    };
    const children = await fanOutChildren(fakes.deps, "PAY-101", doc);
    expect(children).toHaveLength(1);
  });
});
