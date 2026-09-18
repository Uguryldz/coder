import { createDb, type Db } from "@maestro/db";
import { defaultPiiPolicy } from "@maestro/pii";
import { PortRegistry, type LlmPort, type ScmPort, type SecretPort, type StoragePort } from "@maestro/ports";
import { createDockerLinuxRunner } from "@maestro/runners";
import { MAESTRO_TASK_QUEUE, PORT_NAMES, startMaestroWorker, type CoreDeps } from "@maestro/workflows";
import { bootPlatform, degradedCapabilities, MISSING_CORE_DEPS } from "../boot.js";
import { roleResolver } from "../stores/gate-directory.js";
import type { DeployEnv } from "../env.js";
import { PrismaConnectionStore } from "../stores/connections.js";
import { isScmConnectionKind } from "@maestro/bff";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { prepareWorkspace, workspaceRootFrom } from "../stores/workspace-prepare.js";

/** `git ls-files` gibi kısa okumalar için. */
const execFileAsync = promisify(execFile);
import { analysisTemplateReaderFor } from "../stores/analysis-template-reader.js";
import { attachmentReaderFor } from "../stores/attachment-reader.js";
import { PrismaTemplateStore } from "../stores/template.js";
import { commentReaderFor } from "../stores/comment-reader.js";
import { docAttacherFor } from "../stores/doc-attacher.js";
import { statusMoverFor } from "../stores/status-mover.js";
import { buildAgentTurnRunner, buildLocalAgentTurnRunner, unrunnableTurnRunner } from "../stores/execution.js";
import { reconcileRunStatuses } from "../stores/reconcile.js";
import { healthPortOf, startWorkerLiveness } from "../worker-liveness.js";
import { prismaSqlExecutor, prismaTransactionRunner } from "../stores/sql.js";
import { llmCallRecorder } from "../stores/llm-call-log.js";
import { connectionModelFrom } from "../stores/connection-model.js";
import { variantAwareModelFrom, variantModelReaderFrom } from "../stores/variant-model.js";
import { tlsSkipFlagFrom } from "../stores/connection-tls.js";
import { connectionSecretsFrom } from "../stores/connection-secrets.js";
import { buildWorkerCore } from "../stores/worker-core.js";
import { connectTemporal } from "../temporal-gateway.js";
import { namespaceServisi, saklamaSuresiniAcilistaAyarla } from "../temporal-retention.js";
import { fail, isEntrypoint } from "./lifecycle.js";
import { poolRootFrom, usableMirror } from "../stores/repo-pool.js";

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
    /**
     * Built BEFORE the ports: `publish`'s deps need the run context store and
     * the receipt store, and `bootPlatform` wires them into the port at
     * registration time (see `buildPublishDeps`).
     *
     * The turn runner is the one member that cannot be built here — it needs
     * the `llm` and `storage` PORTS, which only exist after `bootPlatform`.
     * So the core is assembled with a placeholder and the real runner is
     * dropped in below, once both halves exist. The alternative orderings both
     * fail: building the ports first breaks `publish`, and making the runner
     * lazy would turn a wiring mistake into a null dereference at the first
     * engineering turn — which is the failure mode `boot.ts` exists to prevent.
     */
    const { core, publishRunDeps } = buildWorkerCore(db, {
      sql: prismaSqlExecutor(db),
      transactions: prismaTransactionRunner(db),
      execution: unrunnableTurnRunner(),
      // Both processes must name the gate's owner group identically: the BFF
      // verifies membership against it, the worker writes it onto the gate and
      // checks the decision's claim against it. Read straight from the raw
      // environment because the stores are built before `bootPlatform`.
      //
      // Eşleme yoksa (`null`) ROL ADINA düşülüyor, ve bu bilerek: BFF de o
      // durumda `actorGroup`a rol adını yazıyor (`GateOwner.unconfigured`).
      // İki taraf aynı adı üretmezse kapı bir adla açılır, başka bir adla
      // kontrol edilir ve her onay `wrong_group` ile reddedilir — OPS-34'ün
      // arızası tam olarak buydu.
      resolveRole: (role) => roleResolver(process.env)(role) ?? role,
    });

    const { env, deployment } = await bootPlatform({
      sql: prismaSqlExecutor(db),
      publishRunDeps,
      // The worker is where model calls happen, so it is where they are
      // recorded. Without this the cost and PII screens answer 200 with an
      // empty table on a deployment that has been spending all day.
      onLlmCall: llmCallRecorder(db.llmCall),
      // The credential a RUN authenticates with now comes from the panel's
      // managed connection when there is one, falling back to the environment.
      // The worker is the process that matters most here: it is where the Jira
      // and GitHub calls of an actual run are made, so a token entered in
      // "Ayarlar & bağlantılar" was previously stored, tested and then ignored
      // by every one of them.
      connectionSecrets: connectionSecretsFrom(db),
      // The model itself, from the same panel rows the credential comes from.
      // Both processes resolve it through this one factory so the endpoint an
      // admin tests green in the panel is the one the run dials — the split
      // `connectionSecrets` closed for the token, closed here for the address.
      //
      // ...ve ADRESİN üstünde bir katman daha: çağıran AJANIN modeli. Bağlantı
      // satırı kurulum gerçeğini (adres/anahtar/on-prem/TLS) verir, Studio'daki
      // "Ajan tanımları" ekranı ise o ajanın hangi modeli konuşacağını. Bu satır
      // olmadan `run.variantId` yalnızca bir etiketti: panelde ajan başına model
      // seçen admin, hepsinin tek modelle koştuğunu görüyordu. Bkz.
      // `stores/variant-model.ts` — düşüşlerin neden sessiz olmadığı orada.
      resolveModel: variantAwareModelFrom({
        base: connectionModelFrom(db),
        variants: variantModelReaderFrom(db),
      }),
      // The handshake, from the same panel rows again: a connection whose
      // admin flagged "TLS doğrulamasını atla" is dialled without certificate
      // verification by every adapter — the run performs the exact handshake
      // the panel's green test did.
      tlsSkipFlag: tlsSkipFlagFrom(db),
    });

    const execution = buildTurnRunner(env, db, deployment.ports);
    /**
     * M103r: the analysis Word/PDF go onto the ticket, if this deployment's
     * work driver can carry a file. `undefined` on Data Center — the documents
     * are then generated and stored, and the journal says they did not land on
     * the ticket. See `stores/doc-attacher.ts` for why the check is structural.
     */
    const docAttacher = docAttacherFor(deployment.ports.work);
    /**
     * The listening rule's status map, made real: the ticket actually moves
     * desk to desk on the operator's board. `undefined` on Data Center, where
     * the driver cannot transition — the flow then narrates in comments as it
     * always has, and the journal says the move was skipped for want of the
     * capability. See `stores/status-mover.ts` for why the check is structural.
     */
    const statusMover = statusMoverFor(deployment.ports.work);
    /**
     * Ticket'ın yorum akışı, intake'in görebilmesi için. Bu olmadan intake
     * yalnız `getTicket` snapshot'ını görür — yani reporter'ın netleştirme
     * sorusuna yazdığı CEVABI görmez, çünkü cevap bir yorumdur. Re-entry
     * köprüsü koşuyu uyandırınca aynı ince ticket'ı okuyup aynı soruyu tekrar
     * sorar: sonsuz iade döngüsü. `undefined` yorum API'si olmayan bir sürücüde
     * (bugün yok — her iki Jira sürücüsü de taşıyor). Yapısal tespitin gerekçesi
     * `stores/comment-reader.ts` içinde.
     */
    const comments = commentReaderFor(deployment.ports.work, env.source["MAESTRO_BOT_ACCOUNT_ID"]);
    /**
     * Ticket'ın ekleri (metin/Word/PDF), analist ve intake görsün diye. Her
     * iki Jira sürücüsü de taşıyor; taşımayan bir sürücüde `undefined` ve
     * analiz eksiz sürer — deftere "ekler okundu" satırı düşmez, o kadar.
     */
    const attachments = attachmentReaderFor(deployment.ports.work);
    /**
     * Studio'nun yayınlanmış analiz şablonu: analistin bölüm talimatları ve
     * belgenin başlıkları. BFF'in okuduğu aynı append-only depo; koşunun
     * çivilendiği sürüm okunur (M83).
     */
    const analysisTemplate = analysisTemplateReaderFor(
      new PrismaTemplateStore(db.analysisTemplateVersion, db.jiraProjectBinding, db.workflowRun),
    );
    const workerCore: CoreDeps = {
      ...core,
      execution: execution.runner,
      ...(docAttacher === undefined ? {} : { docAttacher }),
      ...(statusMover === undefined ? {} : { statusMover }),
      ...(comments === undefined ? {} : { comments }),
      ...(attachments === undefined ? {} : { attachments }),
      analysisTemplate,
    };

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

    /**
     * Printed AFTER the "polling" line, at warn level, on purpose.
     *
     * "The worker started" and "the worker can finish a run" are different
     * claims, and only the first one is proved by getting this far. An
     * operator who sees the success line and nothing else will reasonably
     * assume the second. This says otherwise, in the same place they are
     * already looking.
     */
    const degraded = degradedCapabilities(execution.degradedReason);
    if (degraded.length > 0) {
      console.warn(
        `[maestro] worker: RUNNING WITH ${degraded.length} DEGRADED CAPABILIT` +
          `${degraded.length === 1 ? "Y" : "IES"} — it polls, but a run that reaches ` +
          "one of these stops there with a named error:\n  - " +
          degraded.join("\n  - "),
      );
    }

    await reconcileOnBoot({
      address,
      namespace: env.TEMPORAL_NAMESPACE,
      runs: db.workflowRun,
      audit: workerCore.audit,
    });

    /**
     * The container's answer to "can this worker still take an analysis?".
     *
     * `restart: unless-stopped` only reacts to the process dying, and the
     * failure that actually strands an install is the opposite one: the worker
     * alive but no longer polling. See `worker-liveness.ts`.
     */
    const healthPort = healthPortOf(process.env);
    const liveness = healthPort === null ? null : startWorkerLiveness({ port: healthPort });
    if (healthPort !== null) {
      console.info(`[maestro] worker: sağlık ucu açık — :${healthPort}/healthz`);
    }

    try {
      await startMaestroWorker({
        address,
        taskQueue,
        registry: withWorkspaceCloning(deployment.registry, env, deployment.ports.secrets, new PrismaConnectionStore(db.connection)),
        ports: deployment.selection,
        core: workerCore,
        /**
         * READY means the Temporal worker is RUNNING — actually polling the
         * queue — and nothing weaker.
         *
         * Reporting ready before `startMaestroWorker` would have proved only
         * that the process reached this line, which is exactly the thing that
         * stays true while a worker is wedged. That would have made the probe
         * agree with the failure it exists to catch.
         */
        onState: (state) => liveness?.setReady(state === "RUNNING"),
      });
    } finally {
      // Reported unready BEFORE the process winds down, so a drain in progress
      // is never mistaken for a healthy worker by an in-flight probe.
      liveness?.setReady(false);
      await liveness?.close();
    }
  } finally {
    await db.$disconnect();
  }
}

/**
 * Bring `WorkflowRun.status` back in step with the engine, once, at boot.
 *
 * A run that exhausts its retries dies inside an activity, so no workflow code
 * runs afterwards and the row it started stays `running` forever. Measured on
 * the pilot: 16 of 16 rows said `running` while Temporal held 11 `Failed` and
 * one `Completed`. The dashboard read the rows and reported dead work as live.
 *
 * Boot is the right moment because it is the one instant this process knows
 * the engine's verdict is settled for everything that ran BEFORE it: whatever
 * the previous worker was doing when it died is now closed, and this pass is
 * what writes it down. Runs that fail while this worker is up are a separate
 * problem — see the note in `reconcile.ts` — and this deliberately does not
 * pretend to solve them.
 *
 * NEVER fatal. A worker that cannot reconcile is a worker with a stale
 * dashboard; a worker that refuses to start is a bank with no delivery at all.
 * The failure is loud and the polling continues.
 *
 * Bu geçiş ayrıca namespace'in SAKLAMA SÜRESİNİ güvenceye alır (aşağıya
 * bakın): Temporal bağlantısını açan tek açılış adımı burası, ve iki iş de
 * aynı fail-soft kurala tabi. Adı `reconcile` kalıyor çünkü asıl işi o;
 * saklama ayarı bir satır ve kendi dosyasında (`temporal-retention.ts`)
 * anlatılıyor, ayrı bir bağlantı açmak ise yalnızca ikinci bir gRPC
 * el sıkışması demek olurdu.
 */
async function reconcileOnBoot(options: {
  address: string;
  namespace: string;
  runs: Parameters<typeof reconcileRunStatuses>[0]["runs"];
  audit: Parameters<typeof reconcileRunStatuses>[0]["audit"];
}): Promise<void> {
  let temporal: Awaited<ReturnType<typeof connectTemporal>> | null = null;
  try {
    temporal = await connectTemporal({
      address: options.address,
      namespace: options.namespace,
    });

    /**
     * SAKLAMA SÜRESİ — imajın kendisi ayarlıyor, operatör hiçbir şey yapmıyor.
     *
     * Burada, çünkü bu bağlantı zaten açık ve bu süreç Temporal'ın SAĞLIKLI
     * olmasını compose'da beklemiş olan tek süreçtir (`depends_on: temporal:
     * service_healthy`). `migrate` konteyneri yalnız Postgres'i bekler —
     * oraya konsaydı Temporal henüz ayakta olmadığı için çoğu kurulumda
     * sessizce atlanırdı. Ayrıntılı gerekçe: `temporal-retention.ts`.
     *
     * `reconcileOnBoot`'un içinde ve ONDAN ÖNCE: aynı `try` bloğunun fail-soft
     * kuralı ikisi için de geçerli, ve süre uzatma kıyastan önce yapılırsa
     * bu açılışta kaybolmaya en yakın koşular da korunmuş olur.
     */
    await saklamaSuresiniAcilistaAyarla({
      servis: namespaceServisi(temporal.connection),
      namespace: options.namespace,
      istenen: process.env["TEMPORAL_RETENTION"],
    });

    const report = await reconcileRunStatuses({
      runs: options.runs,
      source: temporal.gateway,
      audit: options.audit,
    });
    if (report.reconciled > 0 || report.unknown > 0) {
      console.info(
        `[maestro] worker: reconciled ${report.reconciled} run row(s) against the engine — ` +
          `${report.stillRunning} still running, ${report.unknown} left untouched because the ` +
          "engine has no execution for them (left `running` on purpose: an unknown run is not a " +
          "finished one, and marking it done would hide any gate still waiting on it)",
      );
    }
  } catch (error) {
    console.warn(
      "[maestro] worker: run-status reconciliation FAILED — the worker polls anyway, but until " +
        "the next boot the dashboard may show finished runs as running. Cause: " +
        (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    if (temporal !== null) await temporal.close();
  }
}

/** What the engineering turn needs from the ports, once they exist. */
interface TurnPorts {
  readonly llm: LlmPort;
  readonly storage: StoragePort;
}

interface BuiltTurnRunner {
  readonly runner: CoreDeps["execution"];
  /**
   * Why the turn still cannot run, or `null` when it can. Feeds
   * `degradedCapabilities` so the boot banner and the code agree.
   */
  readonly degradedReason: string | null;
}

/**
 * The engineering turn's runner, built from the ports and the sandbox fleet.
 *
 * Three collaborators used to be missing here and the seam refused by name.
 * They exist now (`@maestro/execution`), so the only thing that can still stop
 * this is DEPLOYMENT configuration: the fleet needs a digest-pinned image, and
 * the runner's own schema refuses an unpinned one (M27).
 *
 * When that image is unset the refusal is narrower than the old one and says
 * something different — "this deployment has no sandbox fleet configured", not
 * "nobody implemented this". An operator can fix the first by setting one
 * variable.
 */
export function buildTurnRunner(env: DeployEnv, db: Db, ports: TurnPorts): BuiltTurnRunner {
  const image = env.RUNNER_IMAGE_LINUX;
  if (image === undefined) {
    return {
      runner: buildLocalAgentTurnRunner({
        llm: ports.llm,
        storage: ports.storage,
        piiPolicy: defaultPiiPolicy(),
        counters: db.strikeCounter,
        tailLimitBytes: DEFAULT_MAX_TAIL_BYTES,
        commandTimeoutSeconds: env.RUNNER_COMMAND_TIMEOUT_SECONDS,
      }),
      degradedReason:
        "AgentTurnRunner (M30/M52/M54): running WITHOUT a sandbox fleet — RUNNER_IMAGE_LINUX is unset, " +
        "so the engineering turn's build/verification commands run inside the worker container against " +
        "the run's clone instead of a digest-pinned sandbox (M21/M27). Protected-path enforcement and the " +
        "strike ledger are unchanged; only the isolation is weaker. Set RUNNER_IMAGE_LINUX to a pinned " +
        "image to move verification into the fleet.",
    };
  }

  const runnerConfig = {
    socketPath: env.DOCKER_SOCKET_PATH,
    platforms: { "linux-node": { image } },
    /**
     * The network the sandbox runs on (M26).
     *
     * Passing it is what turns egress confinement ON: `verifyEgressNetwork`
     * returns immediately when no name is configured, and a container with no
     * network setting joins the daemon's default bridge — which reaches the
     * internet. An agent session reading a bank's repository must not.
     *
     * The driver verifies the network is `Internal: true` before it runs
     * anything, so a name that points at a bridge with egress fails closed
     * rather than confining nothing.
     */
    ...(env.RUNNER_NETWORK === undefined
      ? {}
      : { egress: { networkName: env.RUNNER_NETWORK } }),
    /**
     * Relaxations an operator has named, and the runner's schema will only
     * honour outside production (M6).
     *
     * `direct-egress` is the one a development stack needs: the network is
     * already `Internal: true`, so nothing reaches the internet, but the driver
     * still wants an egress PROXY — because an internal network stops the
     * traffic while a proxy is what RECORDS the attempt. That record is the
     * part a bank audit asks for, which is why the relaxation exists as a
     * named opt-in rather than a default, and why production refuses it
     * outright no matter what this variable says.
     */
    ...(env.RUNNER_ALLOW_UNSAFE === undefined && env.RUNNER_SANDBOX_USER === undefined
      ? {}
      : {
          sandbox: {
            ...(env.RUNNER_ALLOW_UNSAFE === undefined
              ? {}
              : { allowUnsafeProfile: env.RUNNER_ALLOW_UNSAFE.split(",").map((entry) => entry.trim()) }),
            ...(env.RUNNER_SANDBOX_USER === undefined ? {} : { user: env.RUNNER_SANDBOX_USER }),
          },
        }),
    // The sandbox must see the clone the agent edits (see env.ts).
    ...(env.RUNNER_WORKSPACE_HOST_ROOT === undefined
      ? {}
      : { workspace: { bindHostRoot: env.RUNNER_WORKSPACE_HOST_ROOT } }),
  };
  const fleet = createDockerLinuxRunner(runnerConfig);

  return {
    runner: buildAgentTurnRunner({
      runner: fleet,
      llm: ports.llm,
      storage: ports.storage,
      piiPolicy: defaultPiiPolicy(),
      counters: db.strikeCounter,
      platform: "linux-node",
      /**
       * MUST be the runner's own tail budget. A verification result whose
       * output filled the tail is treated as a failure, because `tail()` drops
       * the HEAD of the stream and a cut test report cannot be shown to have
       * come from the run it appears to describe. Reading the default from the
       * same schema the runner parsed is what keeps the two in step.
       */
      tailLimitBytes: DEFAULT_MAX_TAIL_BYTES,
      commandTimeoutSeconds: env.RUNNER_COMMAND_TIMEOUT_SECONDS,
    }),
    degradedReason: null,
  };
}

/**
 * The runner's `maxTailBytes` default, mirrored.
 *
 * `DockerRunnerConfig` owns the number and this deployment does not override
 * it. Mirrored rather than imported because the config type is the parsed
 * shape, not a constant — and a wrong value here fails SAFE in only one
 * direction, so it is stated where it can be seen rather than inferred.
 */
const DEFAULT_MAX_TAIL_BYTES = 16_384;

if (isEntrypoint(import.meta.url)) {
  await main().catch(fail);
}

/**
 * ÇALIŞMA ALANI KOŞU BOYUNCA YERİNDE DURMAZ — VE DURDUĞU VARSAYILIYORDU.
 *
 * Klon bir dönem YALNIZCA koşu başlarken açılıyordu (`bin/bff.ts`,
 * `checkoutOrNull`). Bu, klonun koşu bitene kadar diskte kaldığı varsayımına
 * dayanıyordu ve varsayım sahada yıkıldı: `/workspace` bir TMPFS birimidir
 * (`docker-compose.yml`, `maestro-workspace`) ve konteyner her yeniden
 * başladığında silinir. Bir sürüm yükseltmesi, bir çökme, bir
 * `docker compose up` yeter — bu oturumda onlarca kez oldu.
 *
 * O zaman koşu satırı hâlâ bir yol taşıyor (`workspacePath` dolu,
 * `workspacePresent: true`) ama dizin YOK. Keşif adımı yalnız yolun boş olup
 * olmadığına baktığı için farkı göremiyor; ajan oturumu var olmayan bir
 * dizinde açılıyor ve künye "okunamadı" diyor. Operatörün gördüğü tek şey
 * "analiz ticket metninden üretildi, kod karşılığı yok" oluyordu — sebebi
 * söyleyen tek satır olmadan, HER yeniden başlatmadan sonra.
 *
 * Bu sarmalayıcı `ScmPort`a `ensureWorkspace` ekler: keşif adımı kodu okumadan
 * önce çalışma alanını VAR EDER. Yerindeyse `prepareWorkspace` zaten dokunmaz
 * (var olan bir checkout'u yeniden klonlamaz); silinmişse yeniden klonlar.
 *
 * Sarmalayıcı olmasının sebebi katman: klonlama `apps/deploy`'un işidir
 * (jeton çözümü, `.env`, kurulumun klon kökü), `@maestro/adapter-github`in
 * değil. Sürücü kendi sözleşmesini korur; yetenek burada, birleştirme
 * noktasında takılır.
 */
/**
 * Klon jetonu: `.env` bir adres söylüyorsa o, yoksa panelde kayıtlı SCM
 * bağlantısının jetonu. `apps/deploy/src/bin/bff.ts`'teki `scmCloneToken` ile
 * AYNI sırayı izler — iki yol ayrışırsa biri klonlar öteki klonlayamaz ve bu,
 * sahada boş bir klon olarak görünür (dizin var, içerik yok).
 */
async function scmCloneTokenFor(
  env: DeployEnv,
  secrets: SecretPort,
  connections: PrismaConnectionStore | undefined,
): Promise<string | undefined> {
  const ref = env.source["SCM_TOKEN_REF"]?.trim() ?? "";
  if (ref !== "") return secrets.get(ref).catch(() => undefined);
  if (connections === undefined) return undefined;
  try {
    const rows = await connections.list();
    const scm = rows.find(
      (row) => row.enabled !== false && isScmConnectionKind(row.kind) && row.secretRef !== null,
    );
    if (scm?.secretRef === undefined || scm.secretRef === null) return undefined;
    return await secrets.get(scm.secretRef).catch(() => undefined);
  } catch {
    return undefined;
  }
}

/**
 * Kodun YAŞADIĞI dosyalar — depo kökünden göreli yollar.
 *
 * Eleme bütçe içindir: bir depo modelin bağlamından büyüktür ve kilit
 * dosyaları, üretilmiş çıktılar, ikili dosyalar bütçeyi doldurup asıl kodu
 * dışarı iterdi. `git ls-files` kullanılıyor çünkü `.gitignore`'u zaten
 * biliyor — ikinci bir eleme listesi tutmak, o listeyle deponun gerçeği
 * arasında ayrışma demekti.
 */
async function listSourceFiles(workspacePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", workspacePath, "ls-files"], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const skip =
    /(^|\/)(node_modules|dist|build|target|vendor|\.git)\/|\.(png|jpe?g|gif|svg|ico|pdf|zip|jar|war|class|exe|dll|so|dylib|woff2?|ttf|eot|mp4|mp3|lock)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/iu;
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !skip.test(line));
}

export function withWorkspaceCloning(
  registry: PortRegistry,
  env: DeployEnv,
  secrets: SecretPort,
  /**
   * Panelde kayıtlı kod deposu bağlantıları — klon jetonu `.env` susunca
   * BURADAN okunur. Yokluğu (`undefined`) yalnız `.env` yolunu bırakır.
   */
  connections?: PrismaConnectionStore,
): PortRegistry {
  const root = workspaceRootFrom(env.source);
  const wrapped = new PortRegistry();
  /**
   * PORT ADLARI PORT_NAMES'TEN GELİR — ELLE YAZILMAZ.
   *
   * Bu döngü bir kez elle yazılmış bir liste taşıyordu ve içindeki `"storage"`
   * YANLIŞTI: registry'deki gerçek ad `"StoragePort"` (tarihsel yazım,
   * `PORT_NAMES` bunu açıkça belgeliyor). Sonuç sessiz ve yıkıcıydı —
   * sarmalayıcı `storage` adıyla hiçbir sürücü BULAMADI, kopyalamadı, ve
   * worker açılışta şununla öldü:
   *
   *   startup failed: no driver "pg-blob" for port "StoragePort" — available: (none)
   *
   * Ölçüldü: worker 3793 kez yeniden başladı ve HİÇ çalışmadı. Klon zincirine
   * yapılan her düzeltme (imaja git, CA yolu, klon kökü, yeniden klonlama)
   * doğruydu ama ölü bir sürecin arkasında duruyordu; sahadaki "kodlar
   * inmiyor" şikayetinin gerçek sebebi buydu.
   *
   * Liste artık `PORT_NAMES`in DEĞERLERİNDEN türüyor: ikinci bir kopya yok,
   * dolayısıyla ayrışabilecek bir ad da yok.
   */
  for (const port of Object.values(PORT_NAMES)) {
    for (const driver of registry.drivers(port)) {
      const factory = registry.resolve<unknown>(port, driver);
      if (port !== "scm") {
        wrapped.register(port, driver, factory);
        continue;
      }
      wrapped.register(port, driver, (config: unknown) => {
        const base = factory(config) as ScmPort;
        return {
          ...base,
          /**
           * ÇALIŞMA ALANININ ÖZETİ — CLI KOLTUĞU OLMAYAN KURULUMLAR İÇİN.
           *
           * Keşif adımı depoyu bir CLI ajan oturumunda okur; o koltuk yoksa
           * (GPT-OSS ya da başka bir HTTP modeliyle çalışan olağan kurulum)
           * oturum açılmaz ve analiz KOD GÖRMEDEN üretilirdi — oysa kod
           * diskte, klon zinciri çalışmıştır.
           *
           * Burası o kodu metne çevirir. İki sınır bilinçli:
           *
           *  · BÜTÇE (`maxBytes`): bir depo modelin bağlamından büyüktür.
           *    Kırpma sessiz değil — `truncated` ile söylenir ve defter yazar.
           *  · SEÇİM: her dosya değil, kodun YAŞADIĞI dosyalar. Kilit
           *    dosyaları, üretilmiş çıktılar ve ikili dosyalar bütçeyi
           *    doldurup asıl kodu dışarı iterdi.
           */
          readWorkspaceDigest: async (request) => {
            const budget = request.maxBytes ?? 200_000;
            try {
              const files = await listSourceFiles(request.workspacePath);
              if (files.length === 0) return null;
              const tree = `DİZİN AĞACI (${String(files.length)} kaynak dosya):\n${files.slice(0, 400).join("\n")}`;
              const picked: { path: string; text: string }[] = [];
              let used = tree.length;
              for (const rel of files) {
                if (used >= budget) break;
                const text = await readFile(join(request.workspacePath, rel), "utf8").catch(() => null);
                if (text === null) continue;
                const slice = text.slice(0, Math.max(0, Math.min(20_000, budget - used)));
                if (slice === "") break;
                picked.push({ path: rel, text: slice });
                used += slice.length;
              }
              return { tree, files: picked, truncated: used >= budget || picked.length < files.length };
            } catch {
              return null;
            }
          },
          ensureWorkspace: async (request) => {
            const scmHost = env.source["SCM_HOST"]?.trim() ?? "";
            const branch = request.targetBranch?.trim() ?? "";
            /**
             * JETON `.env` SUSUNCA PANELDEN OKUNUR — BFF'TEKİYLE AYNI SIRA.
             *
             * Burası bir dönem YALNIZ `SCM_TOKEN_REF`e bakıyordu ve o, BFF'in
             * `scmCloneToken`ından sessizce AYRIŞMIŞTI: BFF `.env` boşken
             * panelde kayıtlı bağlantının jetonunu kullanıyor, worker
             * kullanmıyordu.
             *
             * Sonuç en kötü türdendi: klon "başarılı" oluyor ama ÖZEL bir depo
             * jetonsuz çekilemediği için dizin BOŞ kalıyordu — `git clone`
             * erişemediği depoda bile çıkış kodu 0 verip dizin bırakabilir.
             * Keşif o boş dizini okuyor, "kod karşılığı yok" diyor ve kimse
             * sebebi göremiyordu. Ölçüldü: canlı worker'da
             * `SCM_TOKEN_REF` boş.
             *
             * İki yol da aynı sırayı izlemeli, yoksa "BFF klonluyor, worker
             * klonlayamıyor" gibi teşhis edilemez bir ayrışma doğar.
             */
            const token = await scmCloneTokenFor(env, secrets, connections);
            /**
             * HAVUZDA AYNA VARSA AĞA ÇIKILMAZ — `checkoutOrNull` ile aynı.
             *
             * İki yol ayrışmamalı: bir dönem BFF klonlayabiliyor ama worker
             * klonlayamıyordu (jeton kaynağı ayrışmıştı) ve bu, teşhis
             * edilemez bir arıza üretmişti. Havuz da iki yola AYNI anda ve
             * aynı kuralla giriyor.
             */
            const mirrorPath = await usableMirror({
              poolRoot: poolRootFrom(env.source),
              host: scmHost === "" ? "github.com" : scmHost,
              repo: request.appId,
            });
            return prepareWorkspace({
              repo: request.appId,
              root,
              runId: request.runId,
              ...(branch === "" ? {} : { branch }),
              // Boş dize "yok" demektir, bir host değil — aynı tuzak
              // `checkoutOrNull`da da belgeli.
              ...(scmHost === "" ? {} : { host: scmHost }),
              ...(token === undefined ? {} : { token }),
              ...(mirrorPath === null ? {} : { mirrorPath }),
            });
          },
        } satisfies ScmPort;
      });
    }
  }
  return wrapped;
}
