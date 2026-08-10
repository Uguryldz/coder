import { AuditChain } from "@maestro/audit";
import {
  BcryptPasswordHasher,
  buildServer,
  EnvSettingsReader,
  InMemoryKillSwitchStore,
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
import { PrismaDocTemplateStore } from "../stores/doc-template.js";
import { PrismaParamStore } from "../stores/params-store.js";
import { PrismaRoutingReader } from "../stores/routing.js";
import { assertStoresDurable, volatileStoreWarning, type StoreDurability } from "../stores/durability.js";
import { postgresProbe, temporalProbe } from "../stores/read-health.js";
import { DEGRADED_READ_MODELS, liveReadModels } from "../stores/read-live.js";
import { postgresChainLock, PrismaAuditStore } from "../stores/audit.js";
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
    // The VALUES are durable now (`PrismaParamStore` reads and writes
    // `Param`/`ParamVersion`); the open four-eyes proposals are not, because a
    // proposal is a value with no approver and the versions table refuses
    // exactly that. Losing one costs the first approver a second click — the
    // value was never applied — so it is reported rather than made a refusal.
    name: "params (pending proposals only)",
    durable: false,
    onRestart: "open four-eyes proposals are lost; applied parameter values survive",
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
  // Built once and shared: the settings screen reports the SAME probe results
  // the health screen does. Two independent probe sets would let one screen
  // call Jira green while the other calls it red, and an operator would have no
  // way to tell which to believe.
  const read = liveReadModels({
    db,
    audit: auditStore,
    probes: [postgresProbe(db), temporalProbe(temporal.gateway)],
  });

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
    // Postgres-backed, where it used to be an EMPTY `InMemoryParamStore`.
    // With no definitions at all, every operational setting the installer had
    // seeded into `Param`/`ParamVersion` was invisible: the params screen
    // showed nothing to configure, and the settings, notify and routing
    // screens could not read the escalation ladder, the channel routing or the
    // data-class policy that were in the database the whole time. A restart
    // also silently discarded anything an operator had changed. The pending
    // four-eyes queue is still process-local — see `PrismaParamStore`.
    params: new PrismaParamStore(db.param, db.paramVersion),
    // Process-local like the two above, and declared in `VOLATILE_STORES` for
    // the same reason: a template version is what an approved analysis was
    // judged against (M83), so losing the history on a restart is a real cost
    // an operator must read rather than discover.
    templates: new InMemoryTemplateStore(),
    // Postgres-backed, unlike the two above: an uploaded corporate template is
    // a FILE somebody produced, not a setting they can retype, and a run pinned
    // to version 2 (M83) cannot render at all if a restart lost version 2.
    // That is why this one got a table (migration 0005) rather than a line in
    // `VOLATILE_STORES`.
    docTemplates: new PrismaDocTemplateStore(db.docTemplateVersion, db.docTemplateOutputRow),
    // Wiring, read from the validated environment (M6) and the live probes.
    // There is no settings table on purpose: an endpoint and a credential path
    // are deployment facts, and a console able to rewrite them could point the
    // bank's Jira integration elsewhere without a deploy.
    settings: new EnvSettingsReader(env.base, read.health, notifyChannels(deployment)),
    routing: new PrismaRoutingReader(db.jiraProjectBinding, db.routingRule),
    killSwitch: new InMemoryKillSwitchStore(),
    // Studio's read side, live (M7). Ten of the twelve read models answer from
    // the tables the worker writes; `runners` and `scans` still refuse by name
    // because nothing in this platform writes either, and a store over an
    // empty table would render "no runners, no findings" — indistinguishable
    // from a healthy fleet. See `stores/read-live.ts`.
    read,
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

  install(async () => {
    await app.close();
    await temporal.close();
    await db.$disconnect();
  });
}

/**
 * Which notify channels this deployment actually registered.
 *
 * Read out of the resolved selection rather than listed by hand: the notify
 * driver's config names its channels (`{ jira: {} }`), so this is the same
 * fact the notifier itself acts on. A hand-kept list here would drift, and the
 * settings screen would then show a channel as live that nothing delivers to
 * — which is worse than showing none, because an operator would stop looking
 * for the reminder that never arrived.
 *
 * The `multi` driver fans out to the channels its config names; any other
 * driver IS its channel, and its own id is the answer.
 */
function notifyChannels(deployment: { selection: { notify: { driver: string; config: unknown } } }): readonly string[] {
  const { driver, config } = deployment.selection.notify;
  if (driver !== "multi") return [driver];
  return typeof config === "object" && config !== null ? Object.keys(config) : [];
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name}: required — the BFF cannot serve without it (M6)`);
  return value;
}

if (isEntrypoint(import.meta.url)) {
  await main().catch(fail);
}
