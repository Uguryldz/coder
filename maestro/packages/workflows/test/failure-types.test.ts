import { describe, expect, it } from "vitest";
import {
  AI_ASSIST_REQUIRED,
  handoverReasonOf,
  LLM_BLOCKED,
  LLM_SCHEMA_UNMET,
} from "../src/failure-types.js";

/**
 * Adlandırılmış aktivite hataları (ai-assist gerekli, politika bloğu, anahtar
 * reddi, şema tutmadı) koşuyu ÖLDÜRMEZ, insana devreder. Bu yardımcı, iş akışı
 * sandbox'ında yakalanan hatanın `cause` zincirinden sebebi çıkarır.
 */
describe("handoverReasonOf", () => {
  it("ActivityFailure → cause ApplicationFailure zincirinden adlandırılmış tipi ve mesajı bulur", () => {
    const error = {
      message: "Activity task failed",
      cause: { type: AI_ASSIST_REQUIRED, message: "analysis needs a human in ai-assist mode: llm.degraded_ai_assist" },
    };
    expect(handoverReasonOf(error)).toBe("analysis needs a human in ai-assist mode: llm.degraded_ai_assist");
  });

  it("doğrudan ApplicationFailure da tanınır; mesajsızsa tip adı döner", () => {
    expect(handoverReasonOf({ type: LLM_BLOCKED, message: "LLM policy blocked analysis: x" })).toBe("LLM policy blocked analysis: x");
    expect(handoverReasonOf({ type: LLM_SCHEMA_UNMET, message: "  " })).toBe(LLM_SCHEMA_UNMET);
  });

  it("adlandırılmamış ya da başka tipteki hata null döner — yayılmaya devam etmeli", () => {
    expect(handoverReasonOf(new Error("ECONNREFUSED"))).toBeNull();
    expect(handoverReasonOf({ type: "KillSwitch", message: "kill switch: all" })).toBeNull();
    expect(handoverReasonOf(null)).toBeNull();
    expect(handoverReasonOf("string")).toBeNull();
  });

  it("döngüsel cause zincirinde takılmaz", () => {
    const a: { cause?: unknown; message: string } = { message: "a" };
    const b = { message: "b", cause: a };
    a.cause = b;
    expect(handoverReasonOf(a)).toBeNull();
  });
});
