import { createDb } from "@maestro/db";
import { MAESTRO_TASK_QUEUE } from "@maestro/workflows";
import { bootPlatform, MISSING_CORE_DEPS } from "../boot.js";
import { prismaSqlExecutor } from "../stores/sql.js";
import { fail, isEntrypoint } from "./lifecycle.js";

/**
 * The Temporal worker process.
 *
 * The ports are composed here for real — `bootPlatform` resolves all eight and
 * throws on the first one that cannot be built, so a misconfigured worker dies
 * at start-up rather than at a gate. What it cannot yet do is RUN: the
 * activities need run-scoped state that nothing implements.
 *
 * Refusing is the point. `@maestro/workflows` would accept in-memory stubs
 * without complaint and the worker would start, poll the task queue, and take
 * tickets — losing every run's context on the first restart, silently, with a
 * Jira comment already posted. A worker that never started is a page at
 * 09:00; a worker that started and forgot is a corrupted audit trail.
 *
 * `startMaestroWorker` from `@maestro/workflows` is the one call this
 * entrypoint is missing, and it is a two-line change once `CoreDeps` exists.
 */
export async function main(): Promise<void> {
  // The dev profile stores blobs in Postgres, so the database is a dependency
  // of composing the ports — not just of running them.
  const url = process.env["DATABASE_URL"];
  if (url === undefined) {
    throw new Error("DATABASE_URL: required — the worker's storage port writes through it (M6)");
  }
  const db = createDb(url);

  try {
    const { env, deployment } = await bootPlatform({ sql: prismaSqlExecutor(db) });

    console.info(
      `[maestro] worker: composed ${Object.keys(deployment.selection).length} ports on profile ` +
        `${env.profile}, task queue ${env.TEMPORAL_TASK_QUEUE ?? MAESTRO_TASK_QUEUE}`,
    );
  } finally {
    await db.$disconnect();
  }

  throw new Error(
    "worker: the ports compose, but the run-scoped stores do not exist yet, so the worker " +
      "refuses to poll rather than accept tickets it would lose on restart (M33). Missing:\n  - " +
      MISSING_CORE_DEPS.join("\n  - "),
  );
}

if (isEntrypoint(import.meta.url)) {
  await main().catch(fail);
}
