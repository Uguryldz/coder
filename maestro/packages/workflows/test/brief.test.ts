import { EMPTY_ANALYSIS_BRIEF } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  developerBrief,
  discoveryNotes,
  loadAnalysis,
  planDeviations,
  ruleChecklist,
  storeAnalysis,
} from "../src/impl/brief.js";
import { record } from "../src/impl/record.js";
import { runContext } from "./doubles.js";
import { makeFakes } from "./fakes.js";
import { analysisDoc } from "./harness.js";

/**
 * The hand-offs between the four agents: analysis → plan → developer →
 * verifier. Each bridge is fail-soft — a consumer that finds nothing behaves
 * exactly as it did before the bridge existed.
 */
describe("brief — analysis document hand-off", () => {
  it("round-trips the document through storage for the doing-role activities", async () => {
    const { deps } = makeFakes();
    const run = runContext();
    const doc = { ...analysisDoc("orta"), businessRules: ["Limit 500.000 TL'yi aşamaz"] };
    expect(await storeAnalysis(deps, run, doc)).toBe(true);
    expect(await loadAnalysis(deps, run)).toEqual(doc);
  });

  it("reads null when nothing was stored — the consumer falls back", async () => {
    const { deps } = makeFakes();
    expect(await loadAnalysis(deps, runContext())).toBeNull();
  });
});

describe("brief — discovery notes", () => {
  it("returns the findings below the count line of the LAST discovery entry", async () => {
    const { deps } = makeFakes();
    const run = runContext();
    await record(deps, run, { kind: "discovery", title: "repo keşfi", detail: "3 dosya · 1 modül\nG1 → src/a.ts:10", key: "d1" });
    await record(deps, run, { kind: "discovery", title: "repo keşfi", detail: "5 dosya · 2 modül\nG1 → src/b.ts:20\nG2 → yok", key: "d2" });
    expect(await discoveryNotes(deps, run)).toBe("G1 → src/b.ts:20\nG2 → yok");
  });

  it("is null for a count-only entry (older digest) and for a run that never discovered", async () => {
    const { deps } = makeFakes();
    const run = runContext();
    expect(await discoveryNotes(deps, run)).toBeNull();
    await record(deps, run, { kind: "discovery", title: "repo keşfi", detail: "12 dosya · 1 modül", key: "d1" });
    expect(await discoveryNotes(deps, run)).toBeNull();
  });
});

describe("brief — developer brief and verifier checklist", () => {
  const doc = {
    ...analysisDoc("orta"),
    requirements: ["Ekstre 'son 3 ay' filtresi"],
    businessRules: ["Filtre yalnız son 3 ayı listeler"],
    gaps: ["Tarih filtresi endpoint'i yok"],
    openQuestions: ["Buton mevcut filtrenin yerine mi geçecek?"],
    plan: {
      files: [{ path: "src/statement/StatementController.java", change: "startDate parametresi eklenir" }],
      endpoints: [{ method: "GET", path: "/api/statement", contract: "startDate=ISO tarih; 400 geçersiz tarih" }],
      dtos: [{ name: "StatementQuery", fields: ["startDate:LocalDate", "endDate:LocalDate"] }],
      conventions: ["src/statement dizinindeki StatementFilter.java'yı örnek al"],
      notes: "",
    },
  };

  it("hands the developer the plan, the rules and the gaps, numbered the way the verifier will cite them", () => {
    const brief = developerBrief(doc);
    expect(brief).toContain("K1. Filtre yalnız son 3 ayı listeler");
    expect(brief).toContain("A1. ");
    expect(brief).toContain("G1. Ekstre 'son 3 ay' filtresi");
    expect(brief).toContain("ONAYLI PLAN");
    expect(brief).toContain("src/statement/StatementController.java — startDate parametresi eklenir");
    expect(brief).toContain("GET /api/statement — startDate=ISO tarih");
    expect(brief).toContain("StatementQuery: startDate:LocalDate, endDate:LocalDate");
    expect(brief).toContain("StatementFilter.java'yı örnek al");
    expect(brief).toContain("E1. Tarih filtresi endpoint'i yok");
    expect(brief).toContain("S1. Buton mevcut filtrenin yerine mi geçecek?");
  });

  it("without a plan it still carries the acceptance criteria — today's task, made explicit", () => {
    const brief = developerBrief({ ...analysisDoc("orta"), ...EMPTY_ANALYSIS_BRIEF });
    expect(brief).toContain("Kabul kriterleri");
    expect(brief).not.toContain("ONAYLI PLAN");
    expect(brief).not.toContain("İş kuralları");
  });

  it("the verifier's checklist is the business rules, or the acceptance criteria when there are none", () => {
    expect(ruleChecklist(doc)).toEqual(["K1. Filtre yalnız son 3 ayı listeler"]);
    const noRules = { ...analysisDoc("orta"), ...EMPTY_ANALYSIS_BRIEF };
    expect(ruleChecklist(noRules)[0]).toMatch(/^A1\. /);
  });
});

describe("brief — plan deviations", () => {
  it("reads every 'PLAN SAPMASI' line the developer wrote, whatever the bullet or separator", () => {
    const text = [
      "Değişen dosyalar: a.ts, b.ts",
      "- PLAN SAPMASI: DTO'ya 'currency' alanı eklendi — mevcut servis onsuz 400 veriyor",
      "* plan sapması - Migration V12 eklendi: tablo kolonu yoktu",
      "PLAN SAPMASI:",
      "bitti",
    ].join("\n");
    expect(planDeviations(text)).toEqual([
      "DTO'ya 'currency' alanı eklendi — mevcut servis onsuz 400 veriyor",
      "Migration V12 eklendi: tablo kolonu yoktu",
    ]);
  });

  it("is empty when the developer stayed on the plan", () => {
    expect(planDeviations("bitti — plana uyuldu")).toEqual([]);
  });
});
