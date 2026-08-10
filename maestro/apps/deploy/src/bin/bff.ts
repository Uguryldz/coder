import { AuditChain } from "@maestro/audit";
import {
  BcryptPasswordHasher,
  buildServer,
  InMemoryKillSwitchStore,
  InMemoryParamStore,
  InMemorySessionStore,
  InMemoryTemplateStore,
  LocalIdentityProvider,
  StaticGateDirectory,
  UNWIRED_CAPABILITY_LINES,
  type BffDeps,
} from "@maestro/bff";
import { createDb } from "@maestro/db";
import { bootPlatform } from "../boot.js";
import { listenAddress } from "../env.js";
import { PrismaJiraProjectBindings } from "../stores/bindings.js";
import { assertStoresDurable, volatileStoreWarning, type StoreDurability } from "../stores/durability.js";
import { postgresProbe, temporalProbe } from "../stores/read-health.js";
import { DEGRADED_READ_MODELS, liveReadModels } from "../stores/read-live.js";
import { postgresChainLock, PrismaAuditStore } from "../stores/audit.js";
import { AuditDecisionReader, AuditPiiReader } from "../stores/read-governance.js";
import { PrismaVariantCatalog } from "../stores/read-variants.js";
import { prismaSqlExecutor, prismaTransactionRunner } from "../stores/sql.js";
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
  // ONE audit store, shared by the chain that appends and the reader that
  // verifies. Two stores over the same table would let `verify()` check a
  // chain nothing wrote (M33).
  //
  // Postgres-backed now, where it used to be in-memory: Studio's audit screen
  // has to read the trail the platform actually wrote, and an in-memory chain
  // would have rendered a verified chain of zero events on a database holding
  // the real one. The lock moves with it — `postgresChainLock` is what stops a
  // second replica from forking the chain, which `LocalChainLock` cannot do.
  const auditStore = new PrismaAuditStore(db.auditLog);
  const deps: BffDeps = {
    work: deployment.ports.work,
    workEvents: jiraWorkEventReader(),
    ci: deployment.ci,
    runs: temporal.gateway,
    audit: new AuditChain({
      store: auditStore,
      lock: postgresChainLock(prismaTransactionRunner(db)),
    }),
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
    // Studio's read side, live (M7). Ten of the twelve read models answer from
    // the tables the worker writes; `runners` and `scans` still refuse by name
    // because nothing in this platform writes either, and a store over an
    // empty table would render "no runners, no findings" — indistinguishable
    // from a healthy fleet. See `stores/read-live.ts`.
    read: liveReadModels({
      db,
      audit: auditStore,
      probes: [postgresProbe(db), temporalProbe(temporal.gateway)],
    }),
    /**
     * The last eight screens (M7), three of them wired.
     *
     * `variants` reads the Variant/VariantVersion tables; `pii` and
     * `decisions` read the SAME audit store the chain appends through — a
     * second store over that table would verify itself, which proves nothing
     * (M33).
     *
     * `eval`, `greenfield` and `cache` are deliberately absent: none of them
     * has a producer, so their routes refuse by name rather than answer an
     * empty page. See `apps/bff/src/routes/unwired.ts` and the boot banner
     * below.
     */
    studio: {
      variants: new PrismaVariantCatalog(db.variant, db.variantVersion),
      pii: new AuditPiiReader(auditStore, db.llmCall),
      decisions: new AuditDecisionReader(auditStore),
    },
    config: { env: env.base },
  };

  const app = await buildServer(deps);
  const { host, port } = listenAddress(env);
  await app.listen({ host, port });
  console.info(`[maestro] bff listening on ${host}:${port}`);

  // Which Studio screens will error, said at boot rather than discovered by
  // the operator who opens one. Same discipline as the worker's banner: a read
  // model that refuses is a capability this image does not have, and an
  // operator reading a green start-up log has no other way to tell.
  if (DEGRADED_READ_MODELS.length > 0) {
    console.warn(
      `[maestro] bff: ${DEGRADED_READ_MODELS.length} read model` +
        `${DEGRADED_READ_MODELS.length === 1 ? "" : "s"} NOT wired — the Studio screens ` +
        `backed by them refuse rather than render an empty page:\n  - ` +
        DEGRADED_READ_MODELS.join("\n  - "),
    );
  }

  // The Studio capabilities that have no producer, named at boot for the same
  // reason as the read models above: an operator reading a green start-up log
  // has no other way to learn that `/eval`, `/greenfield` and `/cache` will
  // answer 503. Each entry leaves this banner when something WRITES its data,
  // not when somebody decides the warning is noisy.
  if (UNWIRED_CAPABILITY_LINES.length > 0) {
    console.warn(
      `[maestro] bff: ${UNWIRED_CAPABILITY_LINES.length} Studio capabilit` +
        `${UNWIRED_CAPABILITY_LINES.length === 1 ? "y has" : "ies have"} no data source — ` +
        `the screens behind them REFUSE (503) rather than render an empty page:\n  - ` +
        UNWIRED_CAPABILITY_LINES.join("\n  - "),
    );
  }

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
