import type { LlmCallLog } from "@maestro/contracts";
import type { AgentTurnResult, SessionReport } from "@maestro/execution";
import { describe, expect, it } from "vitest";
import { designTests, reviewDiff, reviewTests, runEngineering, runTests } from "../src/impl/engineering.js";
import { makeFakes } from "./fakes.js";

/**
 * Mühendislik yarısı MÜHENDİS ajanıyla koşar — analistinkiyle değil.
 *
 * Göç 0022 öncesi bir run tek bir ajana iğneleniyordu, ve onu iğneleyen
 * `activeAnalystVariantId` `role: 'analyst'` diye soruyordu. Sonra HER adım o
 * tek değeri okuyordu: intake, analiz, iki gözden geçiren, test tasarımı, test
 * özeti ve kodu yazan turun kendisi. Yani Studio'da ayrı bir `engineer-*` ajanı
 * tanımlayan admin — kendi modeli, kendi personasıyla — onu hiçbir yere
 * uygulatmıyordu, ve bunu söyleyen hiçbir satır yoktu.
 *
 * Aşağıdaki testler bu paketin BEŞ mühendislik çağrısının hepsinin mühendis
 * ajanını taşıdığını sabitler. Beşi tek tek sınanıyor çünkü hata da tam olarak
 * öyle işlemişti: değeri okuyan yer çoktu, hepsi aynı yanlış yeri okuyordu.
 */

function report(over: Partial<SessionReport> = {}): SessionReport {
  return {
    runId: "run-pay-101-0001",
    ticketKey: "PAY-101",
    resumeToken: "session-2",
    workspacePath: "/w/pay-101",
    finalText: "bitti",
    changedFiles: [],
    diff: { files: 1, insertions: 1, deletions: 0 },
    commands: [
      { name: "test", command: ["pnpm", "test"], exitCode: 0, stdoutTail: "ok", stderrTail: "", durationMs: 1 },
    ],
    protectedViolations: [],
    strikes: null,
    at: "2026-08-09T09:05:00+03:00",
    ...over,
  };
}

const ok = (): AgentTurnResult => ({ status: "ok", report: report() });

const LOG: LlmCallLog = {
  at: "2026-08-09T09:00:00+03:00",
  runId: null,
  role: "dev_reviewer",
  variantId: "engineer-kredi",
  driver: "openai-compat",
  model: "fake",
  tokensIn: 0,
  tokensOut: 0,
  cachePct: null,
  usd: null,
  dataClass: "dahili",
};

/** İki ajanlı bir kurulum: analiz `analyst-kredi`, kod `engineer-kredi`. */
const TWO_AGENTS = { variantId: "analyst-kredi", engineerVariantId: "engineer-kredi" };

describe("mühendislik adımları mühendis ajanını kullanır", () => {
  it("kodu yazan tur (6a)", async () => {
    const fakes = makeFakes({ context: TWO_AGENTS, runTurn: () => ok() });

    await runEngineering(fakes.deps, "PAY-101", null, "iş");

    expect(fakes.recorded.turns[0]?.variantId).toBe("engineer-kredi");
  });

  it("testleri koşan tur (10)", async () => {
    const fakes = makeFakes({
      context: TWO_AGENTS,
      runTurn: () => ok(),
      // Tur bittikten sonra çıktıyı ÖZETLEYEN bir model çağrısı daha var.
      generateObject: () => ({ status: "ok", value: { total: 1, failed: 0, coveragePct: 90 }, log: LOG }),
    });

    await runTests(fakes.deps, "PAY-101");

    expect(fakes.recorded.turns[0]?.variantId).toBe("engineer-kredi");
  });

  it("kod gözden geçiren (6c), test gözden geçiren (8) ve test tasarımı", async () => {
    // Üçü de `generateObject` yolundan geçiyor: ajanı isteğin kendisinde.
    const fakes = makeFakes({
      context: TWO_AGENTS,
      generateObject: (schemaName) =>
        schemaName === "test-design"
          ? { status: "ok", value: { scenarios: 3 }, log: LOG }
          : { status: "ok", value: { approved: true, findings: [] }, log: LOG },
    });

    await reviewDiff(fakes.deps, "PAY-101");
    await reviewTests(fakes.deps, "PAY-101");
    await designTests(fakes.deps, "PAY-101");

    expect(fakes.recorded.llm.map((c) => [c.schemaName, c.variantId])).toEqual([
      ["diff-review", "engineer-kredi"],
      ["test-review", "engineer-kredi"],
      ["test-design", "engineer-kredi"],
    ]);
  });

  it("testleri özetleyen çağrı (test-digest) da mühendis ajanıyla yapılır", async () => {
    const fakes = makeFakes({
      context: TWO_AGENTS,
      runTurn: () => ok(),
      generateObject: () => ({
        status: "ok",
        value: { total: 1, failed: 0, coveragePct: 90 },
        log: LOG,
      }),
    });

    await runTests(fakes.deps, "PAY-101");

    expect(fakes.recorded.llm[0]?.schemaName).toBe("test-run");
    expect(fakes.recorded.llm[0]?.variantId).toBe("engineer-kredi");
  });

  it("ayrı mühendis ajanı yoksa analistin ajanına düşer — göç öncesi davranış", async () => {
    // Tek ajanlı kurulum ve 0022 öncesi açılmış her satır. Doğru cevap, kodu
    // ajansız koşturmak değil; tek ajan varsa mühendis de odur.
    const fakes = makeFakes({
      context: { variantId: "analyst-kredi", engineerVariantId: "" },
      runTurn: () => ok(),
    });

    await runEngineering(fakes.deps, "PAY-101", null, "iş");

    expect(fakes.recorded.turns[0]?.variantId).toBe("analyst-kredi");
  });
});
