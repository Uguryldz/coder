import { describe, expect, it } from "vitest";
import { createMockLlm } from "@maestro/test-kit";
import { RoleOutputError } from "../src/errors.js";
import { runAnalyst } from "../src/role-analyst.js";
import type { SourceEntry } from "../src/schema-builder.js";
import { analysisSchemaName } from "../src/schema-builder.js";
import { DEFAULT_ANALYSIS_TEMPLATE } from "../src/template.js";
import { analysisContext, outcomeLlm, scriptedLlm, validAnalysis } from "./fixtures.js";

const template = DEFAULT_ANALYSIS_TEMPLATE;
const context = analysisContext();
const base = { template, context, variantId: "web", dataClass: "dahili" as const };

function withoutSection(key: string) {
  const doc = validAnalysis();
  delete doc.sections[key];
  doc.sections["sources"] = (doc.sections["sources"] as SourceEntry[]).filter(
    (s) => s.section !== key,
  );
  return doc;
}

describe("runAnalyst", () => {
  it("returns the analysis on a first-pass answer", async () => {
    const { llm } = scriptedLlm([validAnalysis()]);
    const result = await runAnalyst({ llm, ...base });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.attempts).toBe(1);
    expect(result.logs).toHaveLength(1);
    expect(result.value.riskTier).toBe("orta");
  });

  it("works against the shared mock LLM, which validates the generated schema", async () => {
    const llm = createMockLlm({
      responses: { [`analyst:${analysisSchemaName(template)}`]: validAnalysis() },
    });
    const result = await runAnalyst({ llm, ...base });
    expect(result.status).toBe("ok");
  });

  it("repairs once with the concrete deficiency list, then accepts (M43)", async () => {
    const first = withoutSection("testApproach");
    const { llm, prompts } = scriptedLlm([first, validAnalysis()]);
    const result = await runAnalyst({ llm, ...base });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.attempts).toBe(2);
    expect(result.logs).toHaveLength(2);

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("GİDERİLECEK EKSİKLER");
    expect(prompts[1]).toContain("Test yaklaşımı");
    expect(prompts[1]).toContain("ÖNCEKİ CEVABIN");
  });

  it("fails closed after the single repair round — no third attempt", async () => {
    const bad = withoutSection("testApproach");
    const { llm, prompts } = scriptedLlm([bad, bad, validAnalysis()]);
    await expect(runAnalyst({ llm, ...base })).rejects.toBeInstanceOf(RoleOutputError);
    expect(prompts).toHaveLength(2);
  });

  it("reports the deficiencies on the error it throws", async () => {
    const doc = validAnalysis();
    doc.sections["sources"] = [];
    const { llm } = scriptedLlm([doc, doc]);
    await expect(runAnalyst({ llm, ...base })).rejects.toMatchObject({
      role: "analyst",
      attempts: 2,
      deficiencies: [expect.stringContaining("Kaynaklar")],
    });
  });

  it("rejects an unsourced analysis even though its shape is perfect (M98/M109)", async () => {
    const doc = validAnalysis();
    doc.sections["sources"] = (doc.sections["sources"] as SourceEntry[]).map((s) => ({
      ...s,
      ref: "src/uydurma/dosya.ts",
      kind: "repo_file" as const,
    }));
    const { llm } = scriptedLlm([doc, doc]);
    await expect(runAnalyst({ llm, ...base })).rejects.toBeInstanceOf(RoleOutputError);
  });

  it("passes a queued quota straight back to the workflow (M55)", async () => {
    const llm = outcomeLlm({
      status: "queued",
      resumeAt: "2026-01-01T01:00:00+00:00",
      reason: "subscription_quota",
    });
    const result = await runAnalyst({ llm, ...base });
    expect(result).toEqual({
      status: "queued",
      resumeAt: "2026-01-01T01:00:00+00:00",
      reason: "subscription_quota",
    });
  });

  it("passes degraded and blocked back untouched (M18/M97)", async () => {
    const degraded = await runAnalyst({
      llm: outcomeLlm({ status: "degraded", messageKey: "llm.degraded", dataClass: "gizli" }),
      ...base,
    });
    expect(degraded.status).toBe("degraded");

    const blocked = await runAnalyst({
      llm: outcomeLlm({ status: "blocked", messageKey: "llm.blocked", dataClass: "gizli" }),
      ...base,
    });
    expect(blocked.status).toBe("blocked");
  });

  it("sends the pinned schema name and the caller's data class to the port", async () => {
    const { llm, requests } = scriptedLlm([validAnalysis()]);
    const result = await runAnalyst({ llm, ...base });
    expect(result.status).toBe("ok");
    expect(requests[0]?.schemaName).toBe("AnalysisDoc@kurumsal-analiz@v3");
    expect(requests[0]?.dataClass).toBe("dahili");
    expect(requests[0]?.role).toBe("analyst");
    expect(requests[0]?.variantId).toBe("web");
  });
});
