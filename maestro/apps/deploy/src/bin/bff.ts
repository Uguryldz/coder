import { AuditChain, InMemoryAuditStore } from "@maestro/audit";
import {
  BcryptPasswordHasher,
  buildServer,
  InMemoryKillSwitchStore,
  InMemoryParamStore,
  InMemorySessionStore,
  InMemoryTemplateStore,
  LocalIdentityProvider,
  StaticGateDirectory,
  type BffDeps,
} from "@maestro/bff";
import { createDb } from "@maestro/db";
import { bootPlatform } from "../boot.js";
import { listenAddress } from "../env.js";
import { PrismaJiraProjectBindings } from "../stores/bindings.js";
import { assertStoresDurable, volatileStoreWarning, type StoreDurability } from "../stores/durability.js";
import { unbridgedReadModels } from "../stores/read-models.js";
import { prismaSqlExecutor } from "../stores/sql.js";
import { PrismaUserDirectory } from "../stores/users.js";
import { connectTemporal } from "../temporal-gateway.js";
import { jiraWorkEventReader } from "../work-events.js";
import { fail, install, isEntrypoint } from "./lifecycle.js";

/**
 * What each process-local store costs on a restart.
 *
 * `assertStoresDurable` turns the kill-switch entry into a refusal in the prod
 * profile; the rest are printed. The list is data rather than prose so the boot
 * path and the operator read the same thing.
 */
const VOLATILE_STORES: readonly StoreDurability[] = [
  {
    name: "killSwitch",
    durable: false,
    onRestart: "the emergency brake reverts to `off` with nobody told (M58)",
  },
  {
    name: "params",
    durable: false,
    onRestart: "M71 parameters fall back to defaults and pending four-eyes proposals are lost",
  },
  {
    name: "templates",
    durable: false,
    onRestart:
      "every published analysis template version is lost, and a run pinned to one (M83) can no longer read what it was judged against",
  },
  {
    name: "sessions",
    durable: false,
    onRestart: "every logged-in user is signed out",
  },
  {
    name: "audit",
    durable: false,
    onRestart: "the hash chain restarts empty; a second replica would fork it (M33)",
  },
];

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

  // Before Temporal, before the socket: a deployment whose emergency brake
  // cannot survive a restart must not reach the point of accepting traffic.
  // Refusing here costs an operator a start-up error; refusing later costs
  // them an incident in which `stop_all` did not stop anything.
  assertStoresDurable(env.profile, VOLATILE_STORES);
  const warning = volatileStoreWarning(VOLATILE_STORES);
  if (warning !== null) console.warn(warning);

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
    // Read from the `JiraProjectBinding` table rather than from a hard-coded
    // empty list. An empty list resolved every project to `null`, so every
    // webhook the bank delivered was accepted and dropped — fail-closed in
    // direction and total in effect, with nothing for an operator to read.
    // An unbound project is still dropped; it now means nobody bound it.
    bindings: new PrismaJiraProjectBindings(db.jiraProjectBinding),
    gates: new StaticGateDirectory(),
    // Both still process-local, and both declared in `VOLATILE_STORES` above
    // rather than left as a comment: the prod profile refuses to boot on the
    // kill switch, and the dev profile prints what a restart would cost.
    params: new InMemoryParamStore(),
    // Process-local like the two above, and declared in `VOLATILE_STORES` for
    // the same reason: a template version is what an approved analysis was
    // judged against (M83), so losing the history on a restart is a real cost
    // an operator must read rather than discover.
    templates: new InMemoryTemplateStore(),
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
