import { audit } from "@orkestra/audit";
import { createLogger } from "@orkestra/config";
import type { AgentRole, JiraTicket } from "@orkestra/contracts";
import { getDb } from "@orkestra/db";
import { callLLM } from "@orkestra/llm";
import { maskObject, ReverseMap, type PIIConfig } from "@orkestra/pii";
import type { z } from "zod";
import { hashKnowledgePack, loadKnowledgePack } from "./knowledge.js";
import { resolveVariant } from "./routing.js";
import { putObject } from "./storage.js";

const log = createLogger("agent-runner");

export interface AgentInvocation<S extends z.ZodTypeAny> {
  workflowRunId: string;
  stepName: string;
  role: AgentRole;
  ticket: JiraTicket;
  userInput: string | object;
  outputSchema: S;
  outputSchemaName: string;
  variantIdOverride?: string;
  correlationId: string;
  piiConfig: PIIConfig;
}

export interface AgentInvocationResult<S extends z.ZodTypeAny> {
  output: z.output<S>;
  variantId: string;
  variantName: string;
  promptVersionId: string;
  tokensIn: number;
  tokensOut: number;
  cacheHits: number;
  costUsdCents: number;
  model: string;
  knowledgeHash: string;
  outputKey: string;
  inputKey: string;
}

const ROLE_MAP: Record<AgentRole, string> = {
  intake: "intake",
  analyst: "analyst",
  developer: "developer",
  dev_reviewer: "dev_reviewer",
  test_designer: "test_designer",
  test_reviewer: "test_reviewer",
  test_runner: "test_runner",
};

export async function runAgent<S extends z.ZodTypeAny>(
  inv: AgentInvocation<S>,
): Promise<AgentInvocationResult<S>> {
  const db = getDb();
  const dbRole = ROLE_MAP[inv.role] as unknown as Parameters<typeof resolveVariant>[0];

  // Resolve variant
  let variantId = inv.variantIdOverride;
  let variantName = "";
  if (!variantId) {
    const resolved = await resolveVariant(dbRole, inv.ticket);
    if (!resolved) throw new Error(`No variant available for role ${inv.role}`);
    variantId = resolved.variantId;
    variantName = resolved.variantName;
  } else {
    const v = await db.agentVariant.findUniqueOrThrow({ where: { id: variantId } });
    variantName = v.name;
  }

  const variant = await db.agentVariant.findUniqueOrThrow({
    where: { id: variantId },
    include: { activeVersion: true },
  });
  if (!variant.activeVersion) {
    throw new Error(`Variant ${variant.name} has no active PromptVersion`);
  }

  const knowledge = await loadKnowledgePack(variantId);
  const knowledgeHash = hashKnowledgePack(knowledge);

  // Prepare user input with PII masking
  const reverseMap = new ReverseMap();
  const userStringRaw =
    typeof inv.userInput === "string" ? inv.userInput : JSON.stringify(inv.userInput, null, 2);
  const userStringMasked = inv.piiConfig.enabled
    ? (maskObject({ text: userStringRaw }, inv.piiConfig, reverseMap) as { text: string }).text
    : userStringRaw;

  // Store input snapshot
  const inputKey = `workflows/${inv.workflowRunId}/steps/${inv.stepName}/input.txt`;
  await putObject(inputKey, userStringMasked);

  // Record StepExecution row
  const step = await db.stepExecution.create({
    data: {
      workflowRunId: inv.workflowRunId,
      stepName: inv.stepName,
      agentRole: dbRole,
      variantId: variantId,
      promptVersionId: variant.activeVersion.id,
      knowledgeHash,
      inputKey,
      model: variant.activeVersion.model,
      status: "running",
      attempt: 1,
    },
  });

  try {
    const result = await callLLM<z.output<S>>({
      role: inv.role,
      model: variant.activeVersion.model,
      systemPrompt: variant.activeVersion.systemPrompt,
      knowledgePack: knowledge,
      userInput: userStringMasked,
      outputSchema: inv.outputSchema,
      outputSchemaName: inv.outputSchemaName,
      temperature: variant.activeVersion.temperature,
      maxTokens: variant.activeVersion.maxTokens,
      correlationId: inv.correlationId,
    });

    // Re-insert PII in output if the mask mapping matches
    const restoredRaw = reverseMap.size() > 0 ? reverseMap.applyReverse(result.raw) : result.raw;

    const outputKey = `workflows/${inv.workflowRunId}/steps/${inv.stepName}/output.json`;
    await putObject(outputKey, restoredRaw, "application/json");

    await db.stepExecution.update({
      where: { id: step.id },
      data: {
        status: "success",
        endedAt: new Date(),
        outputKey,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        cacheHits: result.cacheHits,
        costUsdCents: result.costUsdCents,
      },
    });

    await db.workflowRun.update({
      where: { id: inv.workflowRunId },
      data: {
        tokenCostUsdCents: { increment: result.costUsdCents },
        tokensIn: { increment: result.tokensIn },
        tokensOut: { increment: result.tokensOut },
        cacheHits: { increment: result.cacheHits },
      },
    });

    await audit({
      workflowRunId: inv.workflowRunId,
      actor: `ai:${variantName}`,
      action: `step.${inv.stepName}.success`,
      subject: inv.stepName,
      payload: {
        variantId,
        promptVersionId: variant.activeVersion.id,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costUsdCents: result.costUsdCents,
        model: result.model,
      },
    });

    return {
      output: result.parsed,
      variantId,
      variantName,
      promptVersionId: variant.activeVersion.id,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      cacheHits: result.cacheHits,
      costUsdCents: result.costUsdCents,
      model: result.model,
      knowledgeHash,
      outputKey,
      inputKey,
    };
  } catch (e) {
    const msg = (e as Error).message;
    log.error({ err: msg, role: inv.role, step: inv.stepName }, "agent failed");
    await db.stepExecution.update({
      where: { id: step.id },
      data: { status: "failed", endedAt: new Date(), errorMessage: msg },
    });
    await audit({
      workflowRunId: inv.workflowRunId,
      actor: `ai:${variantName}`,
      action: `step.${inv.stepName}.failed`,
      subject: inv.stepName,
      payload: { error: msg },
    });
    throw e;
  }
}
