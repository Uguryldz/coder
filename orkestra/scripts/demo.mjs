import { Client, Connection } from "@temporalio/client";
import { PrismaClient } from "@prisma/client";
import { setTimeout as sleep } from "node:timers/promises";

const connection = await Connection.connect({ address: "localhost:7233" });
const client = new Client({ connection, namespace: "orkestra" });
const db = new PrismaClient();

const ticketKey = `DEMO-${Date.now()}`;
const workflowId = `ticket-${ticketKey}`;

console.log(`\n🚀 Ticket ${ticketKey} workflow başlatılıyor...`);
const handle = await client.workflow.start("ticketLifecycleWorkflow", {
  workflowId,
  taskQueue: "orkestra-default",
  args: [{ ticketId: ticketKey, ticketKey, projectKey: "DEMO", correlationId: `demo-${Date.now()}` }],
});
console.log(`✓ ${workflowId} başladı\n  Temporal UI: http://localhost:8233/namespaces/orkestra/workflows/${workflowId}\n`);

async function waitForStep(step, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await db.workflowRun.findFirst({ where: { temporalWorkflowId: workflowId } });
    if (r?.currentStep?.startsWith(step)) {
      console.log(`  📍 ${step.padEnd(30)} status=${r.status}`);
      return r;
    }
    await sleep(1000);
  }
  throw new Error(`Timeout: ${step}`);
}

async function approve(user, who) {
  await handle.signal("approve", {
    workflowRunId: "x", ticketKey, command: "approve", args: "",
    user: { accountId: user, name: who }, commentId: `c-${Date.now()}`, at: new Date().toISOString(),
  });
  console.log(`  ✓ /approve (${who})\n`);
}

try {
  await sleep(3000);
  await waitForStep("4-po-approval");
  await approve("user-po", "Ayşe PO");

  await waitForStep("5-tech-lead-approval");
  await approve("user-tl", "Ali Tech Lead");

  await waitForStep("9-qa-approval");
  await approve("user-qa", "Zeynep QA");

  await waitForStep("10b-ci-gate");
  await handle.signal("ci-result", { success: true, url: "http://ci.demo/pass" });
  console.log(`  ✓ CI green signal\n`);

  await waitForStep("11-qa-results-approval");
  await approve("user-qa", "Zeynep QA");

  await waitForStep("12-pr-approval");
  await approve("user-tl2", "Mehmet Tech Lead #2");

  const result = await handle.result();
  console.log(`\n🎉 FİNAL: ${JSON.stringify(result)}\n`);
} catch (e) {
  console.error(`❌ ${e.message}`);
  const r = await db.workflowRun.findFirst({ where: { temporalWorkflowId: workflowId } });
  console.log(`  son step: ${r?.currentStep} / status: ${r?.status}`);
}
await db.$disconnect();
await connection.close();
