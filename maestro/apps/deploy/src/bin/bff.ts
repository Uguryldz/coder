import { AuditChain, InMemoryAuditStore } from "@maestro/audit";
import {
  BcryptPasswordHasher,
  buildServer,
  InMemoryKillSwitchStore,
  InMemoryParamStore,
  InMemorySessionStore,
  LocalIdentityProvider,
  StaticGateDirectory,
  StaticJiraProjectBindings,
  type BffDeps,
} from "@maestro/bff";
import { createDb } from "@maestro/db";
import { bootPlatform } from "../boot.js";
import { listenAddress } from "../env.js";
import { unbridgedReadModels } from "../stores/read-models.js";
import { prismaSqlExecutor } from "../stores/sql.js";
import { PrismaUserDirectory } from "../stores/users.js";
import { connectTemporal } from "../temporal-gateway.js";
import { jiraWorkEventReader } from "../work-events.js";
import { fail, install, isEntrypoint } from "./lifecycle.js";

/**
 * The BFF process — the platform's single data door (M7).
 *
 * Boot order is the deployment's dependency order, and every step may refuse:
 * environment, ports, database, Temporal, then the socket. Listening comes
 * last on purpose. A process that accepts a webhook before it can reach the
 * workflow engine answers 200 to a delivery it then drops, and Jira does not
 * redeliver on Maestro's behalf.
 */
export async function main(): Promise<void> {
  // The database comes first: the dev profile's pg-blob storage driver writes
  // through it, so the platform cannot be composed without it.
  const url = required(process.env["DATABASE_URL"], "DATABASE_URL");
  const db = createDb(url);

  const { env, deployment } = await bootPlatform({ sql: prismaSqlExecutor(db) });

  const temporal = await connectTemporal({
    address: required(env.base.TEMPORAL_ADDRESS, "TEMPORAL_ADDRESS"),
    namespace: env.TEMPORAL_NAMESPACE,
    ...(env.TEMPORAL_TASK_QUEUE === undefined ? {} : { taskQueue: env.TEMPORAL_TASK_QUEUE }),
  });

  const users = new PrismaUserDirectory(db.user);
  const deps: BffDeps = {
    work: deployment.ports.work,
    workEvents: jiraWorkEventReader(),
    ci: deployment.ci,
    runs: temporal.gateway,
    // In-memory for now: `@maestro/audit` ships no Postgres store, and the
    // hash chain's lock is process-local with it (M33). Named in RAPOR.md as
    // a blocker rather than papered over — a single BFF is correct, a second
    // replica writing the same chain is not.
    audit: new AuditChain({ store: new InMemoryAuditStore() }),
    sessions: new InMemorySessionStore(),
    identity: new LocalIdentityProvider(users, new BcryptPasswordHasher()),
    users,
    bindings: new StaticJiraProjectBindings([]),
    gates: new StaticGateDirectory(),
    params: new InMemoryParamStore(),
    killSwitch: new InMemoryKillSwitchStore(),
    // Studio's read side, unwired (M7). Every one of the twelve read models
    // needs a Postgres store that does not exist yet, so each refuses by name
    // instead of returning an empty page. The BFF's in-memory read models
    // would boot cleanly and render "no runs, no open gates, nothing to
    // approve" — indistinguishable from a quiet Friday, and wrong. See
    // `MISSING_READ_MODELS` and the note in stores/read-models.ts.
    read: unbridgedReadModels(),
    config: { env: env.base },
  };

  const app = await buildServer(deps);
  const { host, port } = listenAddress(env);
  await app.listen({ host, port });
  console.info(`[maestro] bff listening on ${host}:${port}`);

  install(async () => {
    await app.close();
    await temporal.close();
    await db.$disconnect();
  });
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name}: required — the BFF cannot serve without it (M6)`);
  return value;
}

if (isEntrypoint(import.meta.url)) {
  await main().catch(fail);
}
