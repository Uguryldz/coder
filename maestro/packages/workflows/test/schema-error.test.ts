import type { LlmCallLog } from "@maestro/contracts";
import { LlmSchemaValidationError } from "@maestro/llm-gateway";
import type { LlmOutcome } from "@maestro/ports";
import { ApplicationFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { describe, expect, it } from "vitest";
import { runIntake } from "../src/impl/intake.js";
import { LLM_SCHEMA_UNMET, SCHEMA_RETRY_MAX_ATTEMPTS } from "../src/impl/outcome.js";
import { makeFakes } from "./fakes.js";

/**
 * The auth defect's TWIN, found while asking whether a small open-weight model
 * (gpt-oss on a vLLM endpoint, which is what the bank runs) can drive document
 * generation.
 *
 * A model that cannot satisfy a strict schema throws rather than returning an
 * `LlmOutcome`: `LlmSchemaValidationError` from the gateway after its own
 * repair round, `RoleOutputError` from `agent-roles` after its two. Neither
 * reaches `resolveOutcome`, and to Temporal a plain thrown error is RETRYABLE —
 * on the thinking proxy's `maximumAttempts: Infinity` ladder. So the run
 * retried the same impossible document forever with a `running` row and nothing
 * on the panel saying why, which is exactly the shape of the 403 defect.
 *
 * The real gateway error class is driven through the fake driver here, so the
 * guard's structural match (`err.name`) is proven against the object the live
 * gateway actually throws rather than a hand-built double.
 */
const schemaError = (): LlmSchemaValidationError =>
  new LlmSchemaValidationError("analysis-doc", 2, [
    "riskTier: Required",
    "impactMatrix: Expected array, received string",
  ]);

const CALL_LOG: LlmCallLog = {
  at: "2026-08-09T09:00:00+03:00",
  runId: null,
  role: "intake",
  variantId: "v1",
  driver: "openai-compat",
  model: "fake",
  tokensIn: 0,
  tokensOut: 0,
  cachePct: null,
  usd: null,
  dataClass: "dahili",
};

/** An activity context pinned to one attempt number, like Temporal's retries. */
const atAttempt = <T>(attempt: number, fn: () => Promise<T>): Promise<T> =>
  new MockActivityEnvironment({ attempt }).run(fn) as Promise<T>;

describe("guardModelCall — a model that cannot satisfy the schema must not retry forever", () => {
  it("rethrows retryably and puts the miss on the panel (N/M in the journal)", async () => {
    const fakes = makeFakes({
      generateObject: () => {
        throw schemaError();
      },
    });

    await expect(atAttempt(1, () => runIntake(fakes.deps, "PAY-101"))).rejects.toSatisfy(
      // The ORIGINAL error, not an ApplicationFailure: the proxy's own ladder
      // owns the backoff and the name is what Temporal records.
      (err: unknown) =>
        err instanceof LlmSchemaValidationError && !(err instanceof ApplicationFailure),
    );

    const line = fakes.journalStore.entries.at(-1);
    expect(line?.title).toBe("model çıktısı şemayı tutturamadı");
    // The concrete deficiency travels to the panel: an operator deciding
    // whether to bind a bigger model needs to see WHAT the model got wrong.
    expect(line?.detail).toContain("analysis-doc");
    expect(line?.detail).toContain(`yeniden denenecek (1/${SCHEMA_RETRY_MAX_ATTEMPTS})`);
  });

  it("counts the attempt Temporal reports, so the panel shows real progress", async () => {
    const fakes = makeFakes({
      generateObject: () => {
        throw schemaError();
      },
    });

    await expect(atAttempt(3, () => runIntake(fakes.deps, "PAY-101"))).rejects.toThrow();
    expect(fakes.journalStore.entries.at(-1)?.detail).toContain(
      `yeniden denenecek (3/${SCHEMA_RETRY_MAX_ATTEMPTS})`,
    );
  });

  it(`attempt ${SCHEMA_RETRY_MAX_ATTEMPTS} hands the ticket to a human and dies non-retryably`, async () => {
    const fakes = makeFakes({
      generateObject: () => {
        throw schemaError();
      },
    });

    await expect(
      atAttempt(SCHEMA_RETRY_MAX_ATTEMPTS, () => runIntake(fakes.deps, "PAY-101")),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApplicationFailure &&
        err.type === LLM_SCHEMA_UNMET &&
        err.nonRetryable === true,
    );

    // The handover trail is complete BEFORE the activity dies, and it points at
    // the thing the operator can actually change — the model, not the key.
    //
    // Satırın DURUMU da yazılır (`status: "handover"`): devri yapan taraf,
    // devrin olduğunu satıra yazmazsa kıyas oraya `done` yazıyor ve tarama
    // ticket'ı bir daha hiç almıyor (canlıda OPS-120..123).
    const handover = fakes.journalStore.entries.find((entry) => entry.kind === "handover");
    expect(handover?.detail).toContain("şemayı tutturamadı");
    expect(handover?.detail).toContain("Modeller");
    expect(fakes.patches).toContainEqual({ mode: "ai_assist", status: "handover" });
    expect(fakes.recorded.notifications.length).toBeGreaterThan(0);
  });

  it("bounds the ROLE layer's own failure too, not just the gateway's", async () => {
    /**
     * `RoleOutputError` is thrown by `runRole` ITSELF, after three rounds of
     * shape-valid but substance-deficient answers — so it is born AFTER the
     * port call returns and the wrapped port (`guardedLlm`) never sees it.
     * That is why `runIntake` wraps the whole role call as well; without it
     * this error rode the unlimited ladder untouched.
     *
     * Driven through the REAL role layer: the fake answers with a well-formed
     * but self-contradictory verdict (complete, yet listing something missing),
     * which `validateIntake` refuses on every round.
     */
    const fakes = makeFakes({
      generateObject: (): LlmOutcome<unknown> => ({
        status: "ok",
        value: {
          // Şekil OLARAK geçerli (`IntakeOutput` bunu ayrıştırır), ama kendi
          // içinde çelişkili: "eksiksiz" diyor ve aynı anda eksik sayıyor.
          // `validateIntake` bunu her turda reddeder — yani hata şemadan değil,
          // rol katmanının anlam denetiminden doğar.
          complete: true,
          missing: [
            {
              field: "kabul kriterleri",
              why: "ticket'ta kabul kriteri yok",
              question: "Kabul kriterleri nelerdir?",
            },
          ],
        },
        log: CALL_LOG,
      }),
    });

    await expect(
      atAttempt(SCHEMA_RETRY_MAX_ATTEMPTS, () => runIntake(fakes.deps, "PAY-101")),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ApplicationFailure && err.type === LLM_SCHEMA_UNMET,
    );
  });
});
