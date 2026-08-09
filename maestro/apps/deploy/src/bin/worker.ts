import { createDb } from "@maestro/db";
import { MAESTRO_TASK_QUEUE, startMaestroWorker } from "@maestro/workflows";
import { bootPlatform, MISSING_CORE_DEPS } from "../boot.js";
import { unwiredAgentTurnRunner } from "../stores/execution.js";
import { prismaSqlExecutor, prismaTransactionRunner } from "../stores/sql.js";
import { buildWorkerCore } from "../stores/worker-core.js";
import { fail, isEntrypoint } from "./lifecycle.js";

/**
 * The Temporal worker process.
 *
 * Through wave 4 this entrypoint composed the ports and then refused to poll:
 * the activities need run-scoped state, and nothing implemented it. Starting
 * anyway would have meant a worker that takes tickets and loses every run's
 * context on the first restart — silently, with a Jira comment already posted.
 *
 * Dalga 5 built those stores (`src/stores/`, all Postgres-backed), so the
 * refusal is gone and this process polls for real. `MISSING_CORE_DEPS` stays
 * as the precondition: if a future dependency arrives half-built it goes in
 * that list, and the worker refuses again — at start-up, in front of an
 * operator, rather than mid-ticket.
 */
export async function main(): Promise<void> {
  // The dev profile stores blobs in Postgres, so the database is a dependency
  // of composing the ports — not just of running them.
  const url = process.env["DATABASE_URL"];
  if (url === undefined) {
    throw new Error("DATABASE_URL: required — the worker's storage port writes through it (M6)");
  }
  const address = process.env["TEMPORAL_ADDRESS"];
  if (address === undefined) {
    throw new Error("TEMPORAL_ADDRESS: required — the worker polls the task queue through it");
  }

  const db = createDb(url);

  try {
    // Built BEFORE the ports: `publish`'s deps need the run context store and
    // the receipt store, and `bootPlatform` wires them into the port at
    // registration time (see `buildPublishDeps`).
    const { core, publishRunDeps } = buildWorkerCore(db, {
      sql: prismaSqlExecutor(db),
      transactions: prismaTransactionRunner(db),
      execution: unwiredAgentTurnRunner(),
    });

    const { env, deployment } = await bootPlatform({
      sql: prismaSqlExecutor(db),
      publishRunDeps,
    });

    if (MISSING_CORE_DEPS.length > 0) {
      throw new Error(
        "worker: the ports compose, but a run-scoped dependency is missing, so the worker " +
          "refuses to poll rather than accept tickets it would lose on restart (M33). Missing:\n  - " +
          MISSING_CORE_DEPS.join("\n  - "),
      );
    }

    const taskQueue = env.TEMPORAL_TASK_QUEUE ?? MAESTRO_TASK_QUEUE;
    console.info(
      `[maestro] worker: composed ${Object.keys(deployment.selection).length} ports on profile ` +
        `${env.profile}, polling ${taskQueue}`,
    );

    await startMaestroWorker({
      address,
      taskQueue,
      registry: deployment.registry,
      ports: deployment.selection,
      core,
    });
  } finally {
    await db.$disconnect();
  }
}

if (isEntrypoint(import.meta.url)) {
  await main().catch(fail);
}
