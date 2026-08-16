import { createJiraCloudWorkPort, createJiraDcWorkPort } from "@maestro/adapter-jira";
import { t } from "@maestro/config";
import type { LlmCallLog } from "@maestro/contracts";
import type { FetchLike } from "@maestro/notify";
import { defaultPiiPolicy, maskOutbound, type LoadedPiiPolicy } from "@maestro/pii";
import type { SecretPort, WorkPort } from "@maestro/ports";
import type { PublishDeps } from "@maestro/publish";
import type { ContainerRunner } from "@maestro/scanners";
import { createPgBlobStorage, type PgBlobStorageDeps } from "@maestro/storage";
import { describeWiring, resolveDeployment, type Deployment, type DeploymentInputs } from "./compose.js";
import { buildAgentRunner } from "./agent-runner.js";
import { jiraCloudConfig, jiraConfig } from "./driver-config.js";
import { loadDeployEnv, type DeployEnv } from "./env.js";
import { PROFILE_DRIVERS } from "./profile.js";
import { buildRegistry } from "./registry.js";
import { buildSecretPort } from "./secrets.js";

/**
 * Boot sequence shared by every service.
 *
 * The order below is the whole of the deployment's dependency graph, and it is
 * a straight line rather than a graph on purpose:
 *
 *   1. validate the environment          — refuses a half-configured process
 *   2. build the SecretPort              — the one port nothing else can supply
 *   3. register every driver             — the only file that imports adapters
 *   4. resolve the profile's ports       — throws on the first one that fails
 *
 * Nothing is lazy. A deployment that is going to fail because `ADO_ORG` is
 * unset fails here, at start-up, in front of an operator — not four hours
 * later in front of a ticket.
 */

export interface BootOptions {
  /** Overrides `process.env`; the tests pass a record instead of mutating it. */
  readonly source?: Record<string, string | undefined>;
  /** `pg-blob` writes through this. Supplied by the service that owns the pool. */
  readonly sql?: unknown;
  readonly fetchImpl?: unknown;
  /** Suppresses the boot banner; the tests boot dozens of times. */
  readonly quiet?: boolean;
  /**
   * The scanners' container runner. See {@link unbridgedScanRunner}: there is
   * no adapter from `RunnerPort` to it today, so a deployment that scans must
   * pass one and a deployment that does not gets the refusing default.
   */
  readonly containerRunner?: ContainerRunner;
  /**
   * The two run-scoped collaborators the publisher cannot invent.
   *
   * Supplied by the service that owns the database pool (the worker does;
   * `compose.test.ts` deliberately does not). Absent, `buildPublishDeps` keeps
   * its refusing stubs — a publisher that cannot name the run must not post a
   * document to a bank's Jira ticket under an invented key, and it must not
   * skip the M75 idempotency check either.
   */
  readonly publishRunDeps?: PublishRunDeps;
  /**
   * Where every model call is recorded, for the cost and PII screens.
   *
   * Same shape of dependency as `publishRunDeps`: only a service that owns the
   * database pool can supply it, so the platform takes it rather than reaching
   * for a client it must not import. Absent, calls still run — the gateway's
   * hook is optional — and the screens simply have nothing to show.
   *
   * That absence is not hypothetical. `LlmCall` rows have only ever been
   * written by the pilot launcher (`bin/pilot.ts`), so the Temporal path
   * produced no spend history at all: `/studio/cost` answered 200 with an
   * empty table on a deployment that had been calling a model all day.
   */
  readonly onLlmCall?: (log: LlmCallLog) => void;
}

/** What the publisher needs that only a database-owning service can supply. */
export interface PublishRunDeps {
  readonly runContext: PublishDeps["runContext"];
  readonly state: PublishDeps["state"];
}

export interface BootedPlatform {
  readonly env: DeployEnv;
  readonly secrets: SecretPort;
  readonly deployment: Deployment;
}

export async function bootPlatform(options: BootOptions = {}): Promise<BootedPlatform> {
  const env = loadDeployEnv(options.source ?? process.env);
  const secrets = buildSecretPort(env);
  const policy = defaultPiiPolicy();

  /**
   * The one ordering constraint in the whole graph.
   *
   * Two ports are built on top of another port rather than on a driver:
   * `notify`'s `jira` channel posts through the WorkPort, and `publish`'s
   * `jira` target does the same. Their `register*` functions demand
   * `deps.work` at REGISTRATION time, so the work port has to exist before
   * the registry that would resolve it does.
   *
   * Hence two passes. The first registers everything that needs no port and
   * resolves `work` from it; the second registers the two that do. The
   * alternative — a lazily-dereferenced proxy — would turn a wiring mistake
   * into a null dereference at the first notification, which is exactly the
   * failure mode this file exists to prevent.
   */
  const work = buildWorkPort(env, secrets);
  /**
   * The same story as `work`, for the same reason: `publish`'s `docx`/`pdf`
   * targets (M103r) write the generated file to an object store, and
   * `registerPublishDrivers` demands the sink at REGISTRATION time — a target
   * that cannot store a file is refused while composing, never mid-ticket.
   *
   * So the storage port is built ahead of the registry too. `resolveDeployment`
   * still builds its own from the registry, exactly as it does for `work`: two
   * clients over one bucket is not a correctness problem, and reusing this
   * instance would make the registry's `storage` entry a lie about where the
   * port came from.
   */
  const sink = buildStorageSink(options);
  const agentRunner = buildAgentRunner(env, secrets);

  const registry = buildRegistry({
    secrets,
    work,
    llm: {
      secrets,
      piiPolicy: policy,
      // Every outbound payload passes the M20 boundary before it leaves the
      // process. The gateway refuses `masked_cloud` routing without it, so
      // this is not an optional nicety — it is what makes the route legal.
      mask: (payload, context) =>
        maskOutbound(payload, { policy, dataClass: context.dataClass, boundary: context.boundary }),
      // Spend and PII history. Optional here for the same reason it is optional
      // on the gateway: a deployment without a database pool (compose.test.ts)
      // still boots, it just records nothing.
      ...(options.onLlmCall === undefined ? {} : { onCallLog: options.onLlmCall }),
      // Agent SESSIONS (M17/M30/M100): step 3ö reads the repository before the
      // analysis is written, step 6a writes the change in the same conversation.
      // Absent, `agentSession` throws and those steps refuse — which is what
      // every deployment did until this was wired.
      ...(agentRunner === undefined ? {} : { agentRunner }),
    },
    // `notify` needs `work` (the jira channel posts through it), `secrets` (the
    // webhook channels read their URL through a SecretPort), and now `fetchImpl`
    // — the transport the teams/slack drivers POST their Adaptive Card / message
    // over. Without it those channels refuse at registration (requireDep); with
    // the real fetch wired here, an admin who activates the teams channel gets a
    // driver that actually delivers. A deployment can override the transport via
    // options.fetchImpl (tests inject a stub); otherwise the platform's fetch.
    notify: {
      secrets,
      work,
      fetchImpl: (options.fetchImpl as FetchLike | undefined) ?? (fetch as unknown as FetchLike),
    },
    publish: {
      ...buildPublishDeps(secrets, policy, options.publishRunDeps),
      work,
      // Absent on a deployment whose storage driver could not be built here;
      // `registerPublishDrivers` then refuses `docx`/`pdf` at composition time,
      // which is the intended loud failure rather than a silent skip.
      ...(sink === undefined ? {} : { sink }),
    },
    scan: { runner: options.containerRunner ?? unbridgedScanRunner() },
  });

  const inputs: DeploymentInputs = {
    env,
    registry,
    secrets,
    ...(options.sql === undefined ? {} : { sql: options.sql }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };
  const deployment = resolveDeployment(inputs);

  if (options.quiet !== true) logWiring(env, deployment);
  return { env, secrets, deployment };
}

/**
 * The work port, built ahead of the registry — Data Center or Cloud.
 *
 * It is built from the same factory and the same config the registry would
 * use, so the instance the notifier posts through and the instance the
 * activities call are configured identically. `resolveDeployment` builds its
 * own from the registry rather than reusing this one — two clients against one
 * Jira is not a correctness problem, and sharing it would make the registry's
 * `work` entry a lie about where the port came from.
 *
 * The driver used to be a hard-coded `createJiraDcWorkPort`, which made the
 * production path unusable against a Cloud site even though the adapter for
 * one exists and `@maestro/adapter-jira` registers both drivers. A deployment
 * whose Jira is Cloud could then only be driven by the pilot — which is how a
 * shortcut engine ends up being the only one anybody can run.
 *
 * The choice is `WORK_DRIVER`, defaulting to Data Center: on-premise is what a
 * bank deploys, and a default that reaches the internet is the wrong way round.
 */
function buildWorkPort(env: DeployEnv, secrets: SecretPort): WorkPort {
  // The profile is the answer to "which driver serves which port"; `WORK_DRIVER`
  // overrides it for a deployment whose Jira is not what its profile assumes —
  // a bank on Data Center running the analysis profile, most of all.
  const driver = env.source["WORK_DRIVER"]?.trim() ?? PROFILE_DRIVERS[env.profile].work;
  if (driver === "jira-cloud") return createJiraCloudWorkPort(jiraCloudConfig(env, secrets));
  return createJiraDcWorkPort(jiraConfig(env, secrets));
}

/**
 * The object store the `docx`/`pdf` targets write their generated file to
 * (M103r), built ahead of the registry — see the call site for why.
 *
 * BEST-EFFORT, and that is the whole design. The `pg-blob` driver every
 * non-prod profile uses needs only the SQL executor the service already owns,
 * so a worker gets a real sink and the binary targets compose. A process that
 * did not supply one (`compose.test.ts`, a service with no pool) gets
 * `undefined`, and `registerPublishDrivers` then refuses `docx`/`pdf` at
 * COMPOSITION time with a message naming the missing sink.
 *
 * Refusing later beats guessing now: the alternative is a sink stub that
 * accepts bytes and drops them, which would produce a receipt naming a key
 * that holds nothing — a document the evidence package claims to have and
 * cannot produce.
 */
function buildStorageSink(options: BootOptions): PublishDeps["sink"] {
  if (options.sql === undefined) return undefined;
  try {
    return createPgBlobStorage(
      { table: "storage_blob" },
      { sql: options.sql as PgBlobStorageDeps["sql"] },
    );
  } catch {
    return undefined;
  }
}

/**
 * `PublishDeps` demands four collaborators the port cannot invent, and two of
 * them are run-scoped: the publisher needs to know which ticket a document
 * belongs to, and where the last receipt for it was written.
 *
 * A service that owns the database pool passes both in (`publishRunDeps`), and
 * they are the real Postgres-backed ones — `PrismaRunContextStore` and
 * `PrismaPublishState`. A service that does not still COMPOSES, and gets stubs
 * that refuse: a publisher that cannot name the run must not post a document
 * to a bank's Jira ticket under an invented key, and it must not silently skip
 * the M75 idempotency check either — republishing would then mean a second
 * comment, every time.
 *
 * `translate` and `pii.policy` are always real.
 */
function buildPublishDeps(
  secrets: SecretPort,
  policy: LoadedPiiPolicy,
  runDeps: PublishRunDeps | undefined,
): PublishDeps {
  const unavailable = (what: string): never => {
    throw new Error(
      `publish: ${what} is not wired — this process did not supply publishRunDeps, so it has ` +
        `no database-backed run context or receipt store (M47/M75)`,
    );
  };
  return {
    translate: t,
    runContext: runDeps?.runContext ?? ((): never => unavailable("runContext")),
    state: runDeps?.state ?? {
      get: () => unavailable("state.get"),
      set: () => unavailable("state.set"),
    },
    pii: { policy },
    secrets,
  };
}

/**
 * The port→driver table, printed once at boot.
 *
 * Only names. The configuration behind them holds resolved S3 key material in
 * the prod profile, and a boot banner is exactly the artefact that ends up in
 * a log aggregator with a wider audience than the process itself.
 */
export function logWiring(env: DeployEnv, deployment: Deployment): void {
  const rows = describeWiring(deployment.selection)
    .map(({ port, driver }) => `    ${port.padEnd(10)} → ${driver}`)
    .join("\n");
  console.info(
    `[maestro] profile=${env.profile} node_env=${env.base.NODE_ENV}\n` +
      `[maestro] ports:\n${rows}`,
  );
}

/**
 * The scanners' runner seam, unfilled — deliberately, and loudly.
 *
 * `@maestro/scanners` needs a `ContainerRunner`: "run this digest-pinned image
 * and give me its COMPLETE stdout". `@maestro/runners` implements `RunnerPort`,
 * which carries no image field and returns stdout TAILS. A truncated scanner
 * report is not a smaller report — it is a parse failure, and a parse failure
 * that got read as a pass would be a security gate that silently stopped
 * gating. The two interfaces genuinely do not meet (both packages say so), so
 * the honest move is a runner that refuses rather than an adapter that
 * pretends.
 *
 * The scan port still COMPOSES — the deployment can prove its wiring — and
 * fails at the first scan with a message that names the missing piece. See the
 * interface request in RAPOR.md.
 */
export function unbridgedScanRunner(): ContainerRunner {
  return {
    run: () =>
      Promise.reject(
        new Error(
          "scan: no ContainerRunner is wired. RunnerPort cannot serve this seam — it carries no " +
            "image and returns stdout tails, and a truncated scanner report must never read as a " +
            "pass (M27). See ARAYÜZ İSTEĞİ in deploy/RAPOR.md.",
        ),
      ),
  };
}

/**
 * The stores a full worker still needs, named so the gap is a documented
 * refusal rather than a surprise.
 *
 * Six entries stood here through wave 4 and the worker refused to poll because
 * of them. Dalga 5 implemented all six against Postgres — they live in
 * `src/stores/` (M44: `@maestro/workflows` declares the interfaces and never
 * imports Prisma) and are assembled by `buildCoreStores`:
 *
 *   RunContextStore  → stores/run-context.ts   (WorkflowRun + its new columns)
 *   GateStore        → stores/gates.ts         (Gate table; decisions from the chain)
 *   ParamReader      → stores/params.ts        (ParamVersion, scope-resolved)
 *   DirectoryReader  → stores/directory.ts     (User.groupsJson; LDAPS pluggable)
 *   IdempotencyGuard → stores/idempotency.ts   (IdempotencyKey, cross-process)
 *   AuditStore       → stores/audit.ts         (AuditLog + pg advisory lock)
 *
 * The seventh dependency, the run journal, was never missing: `@maestro/memory`
 * has shipped `journalStoreFromDb` — Postgres-backed, append-only, keyed by
 * `(runId, seq)` — since wave 1. It is wired in `buildWorkerCore` alongside
 * the six above.
 *
 * The list is therefore EMPTY, and the worker polls. It stays in the code
 * rather than being deleted because it is the worker's start-up precondition:
 * `bootWorker` refuses while anything is in it, so a future dependency that
 * arrives half-built is a refusal at 09:00 in front of an operator rather than
 * a run that loses its context on the first restart.
 */
export const MISSING_CORE_DEPS: readonly string[] = [];

/**
 * Capabilities this image does NOT have, though it starts cleanly.
 *
 * `MISSING_CORE_DEPS` is a start-up precondition: anything in it stops the
 * worker from polling at all. This list is the other half of the same honesty
 * and needs to exist separately, because an entry here must NOT stop the
 * worker — twelve of the nineteen steps need nothing from it, and refusing to
 * boot would take those down to protect a step they never reach.
 *
 * What it prevents is a quieter failure than a crash: an image tagged "wave 5
 * done, worker running" that accepts a ticket, works through intake and
 * analysis, opens the approval gate, and only then stops at the turn that
 * would write the code. The worker IS running. The run still cannot finish.
 * An operator reading a green start-up log has no way to tell, so the log says
 * it at boot instead, and `bootWorker`'s caller prints it.
 *
 * An entry leaves this list when its capability is implemented, not when
 * somebody decides the message is noisy.
 */
export const DEGRADED_CAPABILITIES: readonly string[] = [
  "Studio read side — runners (M60): `/studio/runners` and `/studio/sandboxes` REFUSE " +
    "with a named error. There is no runner-fleet table and `RunnerPort` exposes no " +
    "fleet-wide inventory, so a runner reports itself to nothing. The other ten read " +
    "models answer from Postgres; these two refuse rather than render an empty fleet, " +
    "which an operator would read as \"no runners are busy\" instead of \"nobody is " +
    "counting them\".",
  "Studio read side — scans (M27): `/studio/scans` REFUSES with a named error. Scan " +
    "results are produced inside the workflow and consumed by the gate that blocks on " +
    "them; nothing persists one, so there is no history to page through. An empty page " +
    "here would read as \"no findings\" on a platform that has never stored a finding.",
];

/**
 * The degraded list for THIS process, including the entries that depend on how
 * it was configured rather than on what was implemented.
 *
 * The engineering turn used to be a permanent member of the list above: its
 * three collaborators had no implementation, so no configuration could have
 * enabled it. They exist now, and whether the turn runs is a deployment
 * question — a sandbox fleet needs a digest-pinned image (M27). A worker with
 * one configured has NO degraded engineering turn and must not print that it
 * does; a worker without one still must.
 *
 * A static list cannot express that, and leaving the entry in permanently
 * would be the quieter failure the list exists to prevent, pointing the other
 * way: an operator reading "not implemented" about something that works.
 */
export function degradedCapabilities(turnRunnerReason: string | null = null): readonly string[] {
  return turnRunnerReason === null
    ? DEGRADED_CAPABILITIES
    : [turnRunnerReason, ...DEGRADED_CAPABILITIES];
}
