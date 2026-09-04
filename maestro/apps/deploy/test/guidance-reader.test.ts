import { describe, expect, it } from "vitest";
import { guidanceReaderFrom, type GuidanceDelegate, type GuidanceRow } from "../src/stores/guidance.js";

/**
 * `guidanceReaderFrom` — the workflow's `GuidanceReader` seam over the
 * `AnalysisGuidance` table. What one agent sees: every global note plus the
 * notes targeted at exactly that agent; never another agent's, never a
 * disabled one (the delegate is asked for `enabled: true` only).
 */

function row(id: string, variantId: string | null, enabled = true): GuidanceRow {
  return { id, title: `başlık ${id}`, content: `içerik ${id}`, enabled, variantId, updatedAt: new Date() };
}

function delegate(rows: GuidanceRow[] | Error): GuidanceDelegate {
  return {
    findMany: ({ where }) => {
      if (rows instanceof Error) return Promise.reject(rows);
      expect(where).toEqual({ enabled: true });
      return Promise.resolve(rows.filter((r) => r.enabled));
    },
    create: () => Promise.reject(new Error("not used")),
    update: () => Promise.reject(new Error("not used")),
    delete: () => Promise.reject(new Error("not used")),
  };
}

describe("guidanceReaderFrom", () => {
  it("returns global notes plus the ones targeted at THIS agent, as {title, content}", async () => {
    const reader = guidanceReaderFrom({
      analysisGuidance: delegate([row("g", null), row("web", "analyst-web"), row("mobil", "engineer-mobile")]),
    });

    expect(await reader.activeGuidance("analyst-web")).toEqual([
      { title: "başlık g", content: "içerik g" },
      { title: "başlık web", content: "içerik web" },
    ]);
  });

  it("asks the table for enabled notes only", async () => {
    const reader = guidanceReaderFrom({
      analysisGuidance: delegate([row("on", null), row("off", null, false)]),
    });
    expect(await reader.activeGuidance("x")).toEqual([{ title: "başlık on", content: "içerik on" }]);
  });

  it("propagates a database failure — swallowing it is the workflow helper's job", async () => {
    const reader = guidanceReaderFrom({ analysisGuidance: delegate(new Error("unreachable")) });
    await expect(reader.activeGuidance("x")).rejects.toThrow("unreachable");
  });
});
