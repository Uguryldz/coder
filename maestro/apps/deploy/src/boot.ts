import { createJiraDcWorkPort } from "@maestro/adapter-jira";
import { t } from "@maestro/config";
import { defaultPiiPolicy, maskOutbound, type LoadedPiiPolicy } from "@maestro/pii";
import type { SecretPort, WorkPort } from "@maestro/ports";
import type { PublishDeps } from "@maestro/publish";
import type { ContainerRunner } from "@maestro/scanners";
import { describeWiring, resolveDeployment, type Deployment, type DeploymentInputs } from "./compose.js";
import { jiraConfig } from "./driver-config.js";
import { loadDeployEnv, type DeployEnv } from "./env.js";
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
    },
    notify: { secrets, work },
    publish: { ...buildPublishDeps(secrets, policy, options.publishRunDeps), work },
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
 * The work port, built ahead of the registry.
 *
 * It is built from the same factory and the same config the registry would
 * use, so the instance the notifier posts through and the instance the
 * activities call are configured identically. `resolveDeployment` builds its
 * own from the registry rather than reusing this one — two clients against one
 * Jira is not a correctness problem, and sharing it would make the registry's
 * `work` entry a lie about where the port came from.
 */
function buildWorkPort(env: DeployEnv, secrets: SecretPort): WorkPort {
  return createJiraDcWorkPort(jiraConfig(env, secrets));
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
