import type { z } from "zod";
import type { GenerateObjectRequest, LlmCallLog } from "@maestro/contracts";
import type { AgentSessionOptions, AgentSessionResult, LlmPort } from "@maestro/ports";

/**
 * Deterministic LLM for tests: canned responses keyed by `role:schemaName`.
 * Responses are validated against the caller's schema, so a fixture that
 * drifts from the contract fails the test instead of passing silently.
 */
export interface MockLlmOptions {
  responses: Record<string, unknown>;
  agentResults?: Record<string, string>; // key: task substring
}

const FIXED_AT = "2026-01-01T00:00:00+00:00";

function logFor(req: GenerateObjectRequest): LlmCallLog {
  return {
    at: FIXED_AT,
    runId: null,
    role: req.role,
    variantId: req.variantId,
    driver: "openai-compat",
    model: "mock-llm",
    tokensIn: 0,
    tokensOut: 0,
    cachePct: null,
    usd: null,
    dataClass: req.dataClass,
  };
}

export function createMockLlm(opts: MockLlmOptions): LlmPort {
  return {
    async generateObject<T>(req: GenerateObjectRequest, schema: z.ZodType<T>) {
      const key = `${req.role}:${req.schemaName}`;
      if (!(key in opts.responses)) {
        throw new Error(`mock-llm: no canned response for "${key}"`);
      }
      const object = schema.parse(opts.responses[key]);
      return { object, log: logFor(req) };
    },
    async agentSession(sessionOpts: AgentSessionOptions): Promise<AgentSessionResult> {
      const entry = Object.entries(opts.agentResults ?? {}).find(([needle]) =>
        sessionOpts.task.includes(needle),
      );
      if (!entry) throw new Error(`mock-llm: no agent result matching task "${sessionOpts.task}"`);
      return {
        resumeToken: `mock-resume-${entry[0]}`,
        finalText: entry[1],
        log: {
          at: FIXED_AT,
          runId: null,
          role: "engineer",
          variantId: "mock",
          driver: "openai-compat",
          model: "mock-llm",
          tokensIn: 0,
          tokensOut: 0,
          cachePct: null,
          usd: null,
          dataClass: "dahili",
        },
      };
    },
  };
}
