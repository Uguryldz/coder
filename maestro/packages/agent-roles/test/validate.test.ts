import { describe, expect, it } from "vitest";
import type { SourceEntry } from "../src/schema-builder.js";
import { DEFAULT_ANALYSIS_TEMPLATE } from "../src/template.js";
import { type Deficiency, validateAnalysis } from "../src/validate.js";
import { analysisContext, validAnalysis } from "./fixtures.js";

const template = DEFAULT_ANALYSIS_TEMPLATE;
const context = analysisContext();

function check(mutate: (doc: ReturnType<typeof validAnalysis>) => void): Deficiency[] {
  const value = validAnalysis();
  mutate(value);
  const result = validateAnalysis({ template, context, value });
  return result.ok ? [] : result.deficiencies;
}

function sources(doc: ReturnType<typeof validAnalysis>): SourceEntry[] {
  return doc.sections["sources"] as SourceEntry[];
}

describe("validateAnalysis", () => {
  it("passes a complete, fully sourced analysis", () => {
    const result = validateAnalysis({ template, context, value: validAnalysis() });
    expect(result.ok).toBe(true);
  });

  it("names the missing section in Turkish (M43)", () => {
    const deficiencies = check((doc) => {
      delete doc.sections["riskAndRollback"];
    });
    expect(deficiencies.map((d) => d.code)).toContain("section_missing");
    expect(deficiencies[0]?.message).toContain("Risk ve geri dönüş planı");
  });

  it("refuses an analysis whose Kaynaklar section is empty (M109)", () => {
    const deficiencies = check((doc) => {
      doc.sections["sources"] = [];
    });
    expect(deficiencies.length).toBeGreaterThan(0);
    expect(JSON.stringify(deficiencies)).toContain("Kaynaklar");
  });

  it("refuses a claim section that no source backs", () => {
    const deficiencies = check((doc) => {
      doc.sections["sources"] = sources(doc).filter((s) => s.section !== "testApproach");
    });
    expect(deficiencies.map((d) => d.code)).toEqual(["section_unsourced"]);
    expect(deficiencies[0]?.message).toContain("Test yaklaşımı");
  });

  it("catches a fabricated reference — the file was never shown to the role (M98)", () => {
    const deficiencies = check((doc) => {
      const first = sources(doc)[0];
      if (first) {
        first.kind = "repo_file";
        first.ref = "src/credit/does-not-exist.ts";
      }
    });
    expect(deficiencies.map((d) => d.code)).toContain("source_fabricated");
    expect(deficiencies[0]?.message).toContain("src/credit/does-not-exist.ts");
  });

  it("accepts a repo card module path as a reference", () => {
    const deficiencies = check((doc) => {
      const entry = sources(doc).find((s) => s.section === "impactMatrix");
      if (entry) entry.ref = "Sources/Kredi";
    });
    expect(deficiencies).toEqual([]);
  });

  it("catches a source pointing at a section the template does not have", () => {
    const deficiencies = check((doc) => {
      const first = sources(doc)[0];
      if (first) first.section = "hayaliBolum";
    });
    expect(deficiencies.map((d) => d.code)).toContain("source_unknown_section");
  });

  it("catches placeholder text that only looks like content", () => {
    const deficiencies = check((doc) => {
      doc.sections["testApproach"] = "TODO: test yaklaşımı sonra yazılacak.";
    });
    expect(deficiencies.map((d) => d.code)).toContain("placeholder");
  });

  it("finds placeholders nested inside lists and field groups", () => {
    const deficiencies = check((doc) => {
      (doc.sections["riskAndRollback"] as Record<string, string>)["rollback"] = "TBD";
    });
    expect(deficiencies.map((d) => d.code)).toContain("placeholder");
  });

  it("reports schema problems with their path", () => {
    const deficiencies = check((doc) => {
      doc.sections["acceptanceCriteria"] = ["yalnız bir madde"];
    });
    expect(deficiencies[0]?.code).toBe("schema");
    expect(deficiencies[0]?.message).toContain("sections.acceptanceCriteria");
  });

  it("does not demand a source for an optional section that was skipped", () => {
    const deficiencies = check((doc) => {
      delete doc.sections["uiApiChanges"];
      doc.sections["sources"] = sources(doc).filter((s) => s.section !== "uiApiChanges");
    });
    expect(deficiencies).toEqual([]);
  });
});
