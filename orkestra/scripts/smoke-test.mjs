#!/usr/bin/env node
/**
 * End-to-end smoke test.
 * Spins up the stack (assumes docker compose up -d is done), seeds a mock ticket,
 * starts a workflow, drives it through via direct Temporal signals in mock LLM mode,
 * verifies final state = "done".
 */
import { PrismaClient } from "@prisma/client";
import { Client, Connection } from "@temporalio/client";
import { setTimeout as sleep } from "node:timers/promises";

const TEMPORAL = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "orkestra";

async function waitUntil(fn, label, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // retry
    }
    await sleep(1500);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  console.log("[smoke] connecting to Temporal…");
  const connection = await Connection.connect({ address: TEMPORAL });
  const client = new Client({ connection, namespace: NAMESPACE });

  console.log("[smoke] starting workflow…");
  const ticketKey = `SMOKE-${Date.now()}`;
  const workflowId = `ticket-${ticketKey}`;
  const handle = await client.workflow.start("ticketLifecycleWorkflow", {
    workflowId,
    taskQueue: "orkestra-default",
    args: [
      {
        ticketId: ticketKey,
        ticketKey,
        projectKey: "SMOKE",
        correlationId: `smoke-${Date.now()}`,
      },
    ],
  });
  console.log("[smoke] workflow started:", workflowId);

  const db = new PrismaClient();
  const run = await waitUntil(
    () => db.workflowRun.findFirst({ where: { temporalWorkflowId: workflowId } }),
    "workflow row",
    30000,
  );
  console.log("[smoke] workflow row:", run.id);

  // Drive human gates
  const fakeUser1 = { accountId: "smoke-po", name: "Smoke PO" };
  const fakeUser2 = { accountId: "smoke-tl", name: "Smoke TL" };
  const fakeUser3 = { accountId: "smoke-qa", name: "Smoke QA" };

  const approveWith = async (user) => {
    await handle.signal("approve", {
      workflowRunId: run.id,
      ticketKey,
      command: "approve",
      args: "",
      user,
      commentId: `c-${Date.now()}`,
      at: new Date().toISOString(),
    });
  };

  async function waitForStep(step, timeoutMs = 45000) {
    return waitUntil(
      async () => {
        const r = await db.workflowRun.findUnique({ where: { id: run.id } });
        if (r?.currentStep?.startsWith(step)) return r;
        return null;
      },
      `step ${step}`,
      timeoutMs,
    );
  }

  console.log("[smoke] waiting for PO approval step…");
  await waitForStep("4-po-approval");
  console.log("[smoke] /approve (PO)");
  await approveWith(fakeUser1);

  await waitForStep("5-tech-lead-approval");
  console.log("[smoke] /approve (Tech Lead)");
  await approveWith(fakeUser2);

  await waitForStep("9-qa-approval");
  console.log("[smoke] /approve (QA)");
  await approveWith(fakeUser3);

  await waitForStep("10b-ci-gate");
  console.log("[smoke] feeding CI success signal");
  await handle.signal("ci-result", { success: true, url: "http://ci.smoke/success" });

  await waitForStep("11-qa-results-approval");
  console.log("[smoke] /approve (QA results)");
  await approveWith(fakeUser3);

  await waitForStep("12-pr-approval");
  console.log("[smoke] /approve (PR) — different user than analysis approver");
  await approveWith({ accountId: "smoke-tl2", name: "Smoke TL2" });

  const result = await handle.result();
  console.log("[smoke] workflow result:", result);
  if (result.status !== "done") {
    console.error("[smoke] FAIL — expected done, got", result);
    process.exit(1);
  }
  console.log("[smoke] OK ✅");
  await connection.close();
  await db.$disconnect();
}

main().catch((e) => {
  console.error("[smoke] error:", e);
  process.exit(1);
});
