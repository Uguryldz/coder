import type { AuditEvent } from "@maestro/contracts";
import { AuditChain, InMemoryAuditStore, type AppendInput, type Clock } from "../src/index.js";

/** Deterministic clock: every read advances by a fixed step. */
export function fixedClock(startIso: string, stepMs = 1_000): Clock {
  let current = Date.parse(startIso);
  return {
    now(): Date {
      const date = new Date(current);
      current += stepMs;
      return date;
    },
  };
}

export const SAMPLE_INPUTS: AppendInput[] = [
  { actor: "maestro-worker", action: "RUN_STARTED", subject: "UGURPAY-101", meta: { runId: "run-0001" } },
  { actor: "maestro-worker", action: "GATE_OPEN", subject: "UGURPAY-101", meta: { gate: "analysis" } },
  { actor: "po.demir@ugurbank.corp", action: "GATE_APPROVE", subject: "UGURPAY-101", meta: { gate: "analysis" } },
  { actor: "ai-via:po.demir@ugurbank.corp", action: "ASSIGN_APP", subject: "UGURPAY-101", meta: { appId: "ugurweb" } },
  { actor: "maestro-runner", action: "SANDBOX_CREATE", subject: "run-0001", meta: {} },
];

export interface SampleChain {
  readonly chain: AuditChain;
  readonly store: InMemoryAuditStore;
  readonly events: AuditEvent[];
}

/** A five-record chain written at one-second intervals from a fixed instant. */
export async function sampleChain(startIso = "2026-08-08T09:00:00.000Z"): Promise<SampleChain> {
  const store = new InMemoryAuditStore();
  const chain = new AuditChain({ store, clock: fixedClock(startIso) });
  const events = await chain.appendMany(SAMPLE_INPUTS);
  return { chain, store, events };
}

/** Structured clone of a record list — tampering tests must not mutate shared state. */
export function clone(events: readonly AuditEvent[]): AuditEvent[] {
  return events.map((event) => structuredClone(event) as AuditEvent);
}
