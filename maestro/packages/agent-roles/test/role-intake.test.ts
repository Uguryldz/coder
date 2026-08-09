import { describe, expect, it } from "vitest";
import { RoleOutputError } from "../src/errors.js";
import {
  buildIntakePrompt,
  runIntake,
  toIntakeResult,
  validateIntake,
} from "../src/role-intake.js";
import { IntakeOutput } from "../src/schemas.js";
import { scriptedLlm, ticket } from "./fixtures.js";

const thin = ticket({
  summary: "Limit artırma",
  description: "Müşteri limitini artırabilsin.",
  components: [],
});

const incomplete = {
  complete: false,
  missing: [
    {
      field: "üst sınır",
      why: "Doğrulama kuralı bu değere bağlı.",
      question: "Limit üst sınırı hangi değerle sınırlanacak?",
    },
    {
      field: "hedef platform",
      why: "Etki analizi ve fan-out buna bağlı.",
      question: "Değişiklik yalnız web'de mi, mobil de kapsamda mı?",
    },
  ],
};

describe("intake prompt", () => {
  it("bans fabrication and hands over the ticket verbatim", () => {
    const prompt = buildIntakePrompt(thin);
    expect(prompt).toContain("UYDURMA KESİNLİKLE YASAK");
    expect(prompt).toContain("Müşteri limitini artırabilsin.");
    expect(prompt).toContain("Bileşenler: -");
  });
});

describe("intake output shape", () => {
  it("offers no field in which an invented value could be returned (M98)", () => {
    expect(Object.keys(IntakeOutput.shape).sort()).toEqual(["complete", "missing"]);
    const smuggled = IntakeOutput.safeParse({
      complete: true,
      missing: [],
      assumedValues: { limit: 50000 },
    });
    expect(smuggled.success).toBe(false);
  });
});

describe("validateIntake", () => {
  it("accepts an incomplete ticket that comes with questions", () => {
    expect(validateIntake(incomplete).ok).toBe(true);
  });

  it("refuses 'incomplete' without a single question", () => {
    const result = validateIntake({ complete: false, missing: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.deficiencies[0]?.code).toBe("no_question");
  });

  it("refuses 'complete' that still lists gaps", () => {
    const result = validateIntake({ complete: true, missing: incomplete.missing });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.deficiencies[0]?.code).toBe("contradiction");
  });
});

describe("runIntake", () => {
  const args = { ticket: thin, variantId: "web", dataClass: "dahili" as const };

  it("asks instead of guessing when the ticket is thin", async () => {
    const { llm } = scriptedLlm([incomplete]);
    const result = await runIntake({ llm, ...args });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.complete).toBe(false);
    expect(result.value.missing.map((m) => m.question)).toEqual([
      "Limit üst sınırı hangi değerle sınırlanacak?",
      "Değişiklik yalnız web'de mi, mobil de kapsamda mı?",
    ]);
  });

  it("repairs a silent 'incomplete' once and then fails closed", async () => {
    const silent = { complete: false, missing: [] };
    const { llm, prompts } = scriptedLlm([silent, incomplete]);
    const repaired = await runIntake({ llm, ...args });
    expect(repaired.status).toBe("ok");
    expect(prompts[1]).toContain("tek bir soru üretilmedi");

    const stubborn = scriptedLlm([silent, silent]);
    await expect(runIntake({ llm: stubborn.llm, ...args })).rejects.toBeInstanceOf(RoleOutputError);
  });

  it("passes a complete ticket through with no question", async () => {
    const { llm } = scriptedLlm([{ complete: true, missing: [] }]);
    const result = await runIntake({ llm, ...args });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(toIntakeResult(result.value)).toEqual({ complete: true });
  });
});

describe("toIntakeResult", () => {
  it("numbers the questions into one clarification comment (step 2b)", () => {
    const result = toIntakeResult(IntakeOutput.parse(incomplete));
    expect(result.complete).toBe(false);
    expect(result.question).toBe(
      "1. Limit üst sınırı hangi değerle sınırlanacak?\n2. Değişiklik yalnız web'de mi, mobil de kapsamda mı?",
    );
  });
});
