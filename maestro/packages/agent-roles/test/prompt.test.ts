import { describe, expect, it } from "vitest";
import { buildAnalysisPrompt, buildRepairPrompt, renderTemplateSpec } from "../src/prompt.js";
import { AnalysisTemplate, DEFAULT_ANALYSIS_TEMPLATE } from "../src/template.js";
import { DEFAULT_PROMPT_TEXTS, promptKeys, text } from "../src/texts.js";
import { MissingPromptError } from "../src/errors.js";
import { analysisContext } from "./fixtures.js";

const context = analysisContext();

describe("analysis prompt", () => {
  const prompt = buildAnalysisPrompt({ template: DEFAULT_ANALYSIS_TEMPLATE, context });

  it("states every section title, instruction and example", () => {
    for (const section of DEFAULT_ANALYSIS_TEMPLATE.sections) {
      expect(prompt).toContain(section.title);
      expect(prompt).toContain(section.aiInstruction);
      if (section.example) expect(prompt).toContain(section.example);
      expect(prompt).toContain(`sections.${section.key}`);
    }
  });

  it("marks mandatory and optional sections apart", () => {
    expect(prompt).toContain("Amaç / iş değeri [zorunlu]");
    expect(prompt).toContain("Ekran / API değişiklikleri [opsiyonel]");
  });

  it("carries the no-fabrication rule and the Turkish output rule", () => {
    expect(prompt).toContain(text(DEFAULT_PROMPT_TEXTS, "ortak.uydurmaYasak"));
    expect(prompt).toContain(text(DEFAULT_PROMPT_TEXTS, "ortak.dil"));
  });

  it("hands over the ticket, the clarifications and the knowledge pack", () => {
    expect(prompt).toContain("UGURPAY-501");
    expect(prompt).toContain("Üst sınır nedir?");
    expect(prompt).toContain("src/credit/limit-policy.ts");
    expect(prompt).toContain("ugurmobil-ios");
    expect(prompt).toContain("test-piramidi.md");
    expect(prompt).toContain("kodlama-standardi.md");
    expect(prompt).toContain("ornek-analiz.md");
  });

  it("describes the expected shape of each format", () => {
    expect(prompt).toContain("etki matrisi");
    expect(prompt).toContain("kaynak listesi");
    expect(prompt).toContain("sütunlar: Yüzey · Durum · Geriye uyum");
    expect(prompt).toContain("en az 3 madde");
  });

  it("grows with the template, not with the code (M108)", () => {
    const extended = AnalysisTemplate.parse({
      ...DEFAULT_ANALYSIS_TEMPLATE,
      version: "v4",
      sections: [
        ...DEFAULT_ANALYSIS_TEMPLATE.sections,
        {
          key: "compliance",
          title: "Mevzuat etkisi",
          aiInstruction: "BDDK ve KVKK etkisini yaz.",
          required: true,
          format: "bullet_list",
          minItems: 2,
        },
      ],
    });
    const grown = buildAnalysisPrompt({ template: extended, context });
    expect(prompt).not.toContain("Mevzuat etkisi");
    expect(grown).toContain("Mevzuat etkisi");
    expect(grown).toContain("BDDK ve KVKK etkisini yaz.");
    expect(grown).toContain("en az 2 madde");
  });

  it("renders the template spec on its own for Studio preview", () => {
    expect(renderTemplateSpec(DEFAULT_ANALYSIS_TEMPLATE, DEFAULT_PROMPT_TEXTS)).toContain(
      "Kurumsal analiz şablonu v3",
    );
  });
});

describe("repair prompt", () => {
  it("quotes the previous answer and every concrete deficiency", () => {
    const repair = buildRepairPrompt("TEMEL", { a: 1 }, [
      { code: "x", message: "Kaynaklar bölümü boş." },
      { code: "y", message: "\"Kapsam\" bölümü zorunlu ama çıktıda yok." },
    ]);
    expect(repair).toContain("TEMEL");
    expect(repair).toContain('"a": 1');
    expect(repair).toContain("Kaynaklar bölümü boş.");
    expect(repair).toContain("GİDERİLECEK EKSİKLER");
  });
});

describe("prompt texts", () => {
  it("interpolates named parameters", () => {
    expect(text(DEFAULT_PROMPT_TEXTS, "eksik.kriterKapsamsiz", { n: "3" })).toContain("3 numaralı");
  });

  it("throws on an unknown key instead of rendering an empty prompt", () => {
    expect(() => text(DEFAULT_PROMPT_TEXTS, "yok.boyle.bir.anahtar")).toThrow(MissingPromptError);
  });

  it("keeps every prompt string in the data file, not in code", () => {
    expect(promptKeys().length).toBeGreaterThan(40);
  });
});
