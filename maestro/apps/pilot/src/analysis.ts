import {
  type AnalysisContext,
  type AnalysisOutput,
  type AnalysisTemplate,
  DEFAULT_ANALYSIS_TEMPLATE,
  runAnalyst,
  toAnalysisDoc,
} from "@maestro/agent-roles";
import type { AnalysisDoc, DataClass, TicketSnapshot } from "@maestro/contracts";
import type { LlmOutcome, LlmPort } from "@maestro/ports";
import type { z } from "zod";

/**
 * The pilot's analysis step, done by the REAL agent-roles analyst.
 *
 * This is what makes "analizi hangi AI agent yapacaksa o, knowledge + variant
 * ile" real (Uğur): the seven-section validation is no longer a hand-rolled Zod
 * in run.ts. It comes from a real analysis TEMPLATE (M43/M108/M109 —
 * `DEFAULT_ANALYSIS_TEMPLATE`), a real `AnalysisContext` and a real VARIANT,
 * exactly the inputs `runAnalyst` was built to take. Adding a section in Studio
 * would change what the pilot validates against with no code change here.
 *
 * The template's sections are bound to the frozen `AnalysisDoc` contract, so
 * `toAnalysisDoc` projects the analyst's output onto the same `AnalysisDoc` the
 * rest of the pilot already consumes (the Jira comment, the Word/PDF, the
 * engineering step). Nothing downstream changes shape.
 */

/**
 * The analysis template the pilot validates against.
 *
 * It is the corporate default straight from agent-roles: the seven M43 sections,
 * each bound to its `AnalysisDoc` contract field, plus M109's `Kaynaklar`
 * (source_list) and `Netleştirilecek açık maddeler` (open_items). Studio would
 * edit this shape in production (M108); the pilot pins the default so the
 * analyst validates against real sections rather than an ad-hoc schema.
 */
export function pilotAnalysisTemplate(): AnalysisTemplate {
  return DEFAULT_ANALYSIS_TEMPLATE;
}

/**
 * Everything the analyst is allowed to know for this run.
 *
 * Today the pilot only has the live Jira ticket, so the ticket is the only
 * populated part of the context and the analyst may only cite it (its reference
 * index is the ticket key + parent key). Discovery, repo cards, knowledge docs,
 * coding standards, example analyses and clarification rounds are the M38/M100
 * inputs the analyst is designed to lean on — they are left EMPTY here, wired
 * the moment the pilot populates them, and every empty one is a deliberate
 * gap rather than a silent omission.
 *
 * TODO(repo-card/knowledge): once the pilot runs repo discovery (step 3o) and
 * loads the M38 knowledge pack for `ugurpay`, fill `discovery.files/modules`,
 * `knowledge.repoCards` (so the impact matrix may cite `repo_card`) and
 * `knowledge.knowledgeDocs`. Until then the analyst is constrained to
 * ticket-sourced claims, which is the honest posture: it cannot cite a repo
 * file it was never shown.
 */
export function buildAnalysisContext(ticket: TicketSnapshot): AnalysisContext {
  return {
    ticket,
    // TODO(repo-card/knowledge): populated from step 3o repo discovery.
    discovery: { appId: ticket.projectKey, files: [], modules: [] },
    // TODO(repo-card/knowledge): populated from the M38 knowledge pack.
    knowledge: { repoCards: [], knowledgeDocs: [], codingStandards: [], exampleAnalyses: [] },
    // TODO: the shortened pilot has no clarification gate (see run.ts step 2b).
    clarifications: [],
  };
}

/**
 * The analyst ran and produced a validated document — both the MASKED copy (safe
 * to persist/journal, M20/M82) and the `display` copy with the real values
 * re-inserted for the human-facing Jira comment and the Word/PDF.
 */
export interface AnalysisResult {
  /** Real values re-inserted — what a reviewer reads and what the docs render. */
  display: AnalysisDoc;
  /** The masked document — the copy an artifact store or journal may keep. */
  masked: AnalysisDoc;
  attempts: number;
}

/**
 * A non-ok analyst outcome the pilot must surface as a step message rather than
 * a stack trace (mirrors the old `think` helper's handling of the same states).
 */
export class AnalysisHaltedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisHaltedError";
  }
}

/**
 * Wrap an `LlmPort` so the pilot can recover the `unmask` function the gateway
 * returns on a masked route.
 *
 * `runAnalyst` is typed against `LlmPort`, whose `ok` branch carries only the
 * MASKED value — the gateway widens that branch with `unmask` (M20/M82), but a
 * caller typed as `LlmPort` never sees it, so `runAnalyst`'s `RoleResult` drops
 * it. The pilot still needs the real values for the reviewer-facing comment and
 * the docs, so this thin proxy captures the last `unmask` off each
 * `generateObject` call without touching the frozen port. When nothing was
 * masked, `unmask` stays the identity, so the display copy equals the masked
 * copy.
 */
function captureUnmask(llm: LlmPort): { port: LlmPort; unmask: <R>(value: R) => R } {
  let last: (<R>(value: R) => R) | undefined;
  const port: LlmPort = {
    async generateObject<T>(
      req: Parameters<LlmPort["generateObject"]>[0],
      schema: z.ZodType<T>,
    ): Promise<LlmOutcome<T>> {
      const outcome = await llm.generateObject(req, schema);
      if (outcome.status === "ok") {
        const un = (outcome as { unmask?: <R>(value: R) => R }).unmask;
        if (un) last = un;
      }
      return outcome;
    },
    agentSession: (opts) => llm.agentSession(opts),
  };
  return {
    port,
    unmask: <R>(value: R): R => (last ? last(value) : value),
  };
}

export interface ProduceAnalysisArgs {
  llm: LlmPort;
  ticket: TicketSnapshot;
  variantId: string;
  dataClass: DataClass;
  template?: AnalysisTemplate;
}

/**
 * Run the real analyst and hand back the `AnalysisDoc` the pilot flow consumes.
 *
 * Fail-closed is unchanged: a template-validation failure (a missing section, a
 * fabricated source, a non-answer body) is a `RoleOutputError` thrown from
 * `runAnalyst` after the single repair round, so an analysis that misses a
 * section never reaches the gate — the same guarantee the old hand-rolled Zod
 * gave, now driven by the real template. The three non-ok LLM states (queued /
 * degraded / blocked) become an `AnalysisHaltedError` with the same wording the
 * old `think` helper produced.
 */
export async function produceAnalysis(args: ProduceAnalysisArgs): Promise<AnalysisResult> {
  const template = args.template ?? pilotAnalysisTemplate();
  const context = buildAnalysisContext(args.ticket);
  const captured = captureUnmask(args.llm);

  const result = await runAnalyst({
    llm: captured.port,
    template,
    context,
    variantId: args.variantId,
    dataClass: args.dataClass,
  });

  if (result.status !== "ok") {
    throw new AnalysisHaltedError(
      result.status === "queued"
        ? `model kuyruğa alındı (kota) — ${result.resumeAt}`
        : `model çağrısı '${result.status}': ${result.messageKey}`,
    );
  }

  // The RoleResult value is the MASKED output; the display copy re-inserts the
  // real values with the captured unmask. Both are projected onto the SAME
  // frozen AnalysisDoc via `toAnalysisDoc` (M43), so the seven-section
  // validation the pilot relies on now comes from the template.
  const maskedOutput: AnalysisOutput = result.value;
  const displayOutput = captured.unmask(maskedOutput);

  return {
    masked: toAnalysisDoc(template, maskedOutput),
    display: toAnalysisDoc(template, displayOutput),
    attempts: result.attempts,
  };
}
