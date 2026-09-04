import type { LlmCallLog } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { writeAnalysis } from "../src/impl/analysis.js";
import { analystGuidance } from "../src/impl/guidance.js";
import { runContext } from "./doubles.js";
import { makeFakes } from "./fakes.js";
import { analysisDoc } from "./harness.js";

/**
 * Studio'nun "Öğrenme kaynakları" ekranı "yeni analizlerde dikkate alınacak"
 * diyordu; notlar tabloya yazılıyor, ekrana geri okunuyor — ve Temporal yolu
 * onları HİÇ okumuyordu (tek tüketici emekli pilottu). Bu blok, analiz adımının
 * artık okuduğunu ve persona ile aynı kurallara uyduğunu sabitliyor.
 */

const LOG: LlmCallLog = {
  at: "2026-08-09T09:00:00+03:00",
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

const NOTES = [
  { title: "Ekstre kuralı", content: "Son 12 ay ile sınırla." },
  { title: "BDDK uyum", content: "Limit değişikliği dört göz ister." },
];

describe("analystGuidance", () => {
  it("run'ın analist varyantının notlarını okur", async () => {
    const { deps } = makeFakes({ guidance: { v1: NOTES } });
    expect(await analystGuidance(deps, runContext())).toEqual(NOTES);
  });

  it("seam bağlı değilse boş liste — bugünkü davranış", async () => {
    const { deps } = makeFakes();
    expect(await analystGuidance(deps, runContext())).toEqual([]);
  });

  it("başlığı ya da içeriği boş notu prompta koymaz, kalanları kırpar", async () => {
    const { deps } = makeFakes({
      guidance: {
        v1: [
          { title: "  Ekstre  ", content: "  kural  " },
          { title: "", content: "başlıksız" },
          { title: "içeriksiz", content: "   " },
        ],
      },
    });
    expect(await analystGuidance(deps, runContext())).toEqual([{ title: "Ekstre", content: "kural" }]);
  });

  it("okuma patlarsa adım DÜŞMEZ, ama uyarı yazılır", async () => {
    const { deps } = makeFakes({ guidance: { v1: new Error("connection refused") } });
    const warnings: string[] = [];

    expect(await analystGuidance(deps, runContext(), (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("v1");
  });
});

describe("analiz adımı öğrenme notlarını görüyor", () => {
  const doc = analysisDoc("orta");
  const ok = () => ({ status: "ok" as const, value: doc, log: LOG });

  function inputOf(fakes: ReturnType<typeof makeFakes>): Record<string, unknown> {
    return fakes.recorded.llm.find((c) => c.schemaName === "analysis-doc")?.input as Record<string, unknown>;
  }

  it("notlar `input`'ta personanın HEMEN ARDINDAN gider", async () => {
    const fakes = makeFakes({
      persona: { v1: "Ölçülü bir analistsin." },
      guidance: { v1: NOTES },
      generateObject: () => ok(),
    });
    await writeAnalysis(fakes.deps, "PAY-101", "pay");
    const input = inputOf(fakes);
    expect(input["guidance"]).toEqual(NOTES);
    expect(Object.keys(input).slice(0, 2)).toEqual(["persona", "guidance"]);
  });

  it("notlar ANALİST varyantından okunur — başka ajanın notu sızmaz", async () => {
    const fakes = makeFakes({
      context: { variantId: "analist-7", engineerVariantId: "muhendis-9" },
      guidance: { "analist-7": [NOTES[0]!], "muhendis-9": [NOTES[1]!] },
      generateObject: () => ok(),
    });
    await writeAnalysis(fakes.deps, "PAY-101", "pay");
    expect(inputOf(fakes)["guidance"]).toEqual([NOTES[0]]);
  });

  it("not yoksa alan HİÇ gitmez — prompt bugünküyle aynı kalır", async () => {
    const fakes = makeFakes({ guidance: { v1: [] }, generateObject: () => ok() });
    await writeAnalysis(fakes.deps, "PAY-101", "pay");
    expect("guidance" in inputOf(fakes)).toBe(false);
  });

  it("okuma patlarsa ANALİZ DÜŞMEZ — notlar bir üst katman, koşulu değil", async () => {
    const fakes = makeFakes({
      guidance: { v1: new Error("postgres unreachable") },
      generateObject: () => ok(),
    });
    const result = await writeAnalysis(fakes.deps, "PAY-101", "pay");
    expect(result.risk).toBe(doc.riskTier);
    expect("guidance" in inputOf(fakes)).toBe(false);
  });
});
