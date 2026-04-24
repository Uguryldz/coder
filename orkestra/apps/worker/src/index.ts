/**
 * Temporal worker host — runs workflow definitions and activity implementations.
 * Role-based task queues let ops scale workers per role independently:
 *   docker compose up -d --scale worker=5
 *   or more finely:
 *   --scale worker-developer=8 --scale worker-analyst=5
 */
import { createLogger, loadConfig } from "@orkestra/config";
import { activities } from "@orkestra/workflows";
import { NativeConnection, Worker } from "@temporalio/worker";

const log = createLogger("worker");

async function main(): Promise<void> {
  const cfg = loadConfig();
  log.info(
    { temporal: cfg.TEMPORAL_ADDRESS, namespace: cfg.TEMPORAL_NAMESPACE },
    "worker starting",
  );

  const connection = await NativeConnection.connect({ address: cfg.TEMPORAL_ADDRESS });

  const role = process.env.WORKER_ROLE ?? "default";
  const taskQueue = role === "default" ? "orkestra-default" : `orkestra-${role}`;

  const worker = await Worker.create({
    connection,
    namespace: cfg.TEMPORAL_NAMESPACE,
    taskQueue,
    workflowsPath: new URL("../../../packages/workflows/src/workflow.ts", import.meta.url).pathname,
    activities,
    maxConcurrentActivityTaskExecutions: Number(process.env.WORKER_MAX_ACTIVITIES ?? 20),
    maxConcurrentWorkflowTaskExecutions: Number(process.env.WORKER_MAX_WORKFLOWS ?? 40),
  });

  log.info({ taskQueue }, "worker ready");

  const shutdown = async (sig: string) => {
    log.info({ sig }, "shutdown signal");
    await worker.shutdown();
    await connection.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await worker.run();
}

main().catch((e) => {
  log.error({ err: String(e), stack: (e as Error).stack }, "worker crashed");
  process.exit(1);
});
