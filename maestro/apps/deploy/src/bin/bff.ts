import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { AuditChain } from "@maestro/audit";
import {
  buildServer,
  compositeHealthReader,
  connectionHealthReader,
  gateStatusesOf,
  identityDrift,
  parseStatusMap,
  resolveBotIdentity,
  resolveDeps,
  restartDeadRun,
  SYSTEM_ACTOR,
  parseAllowedStatuses,
  EnvSettingsReader,
  UNWIRED_CAPABILITY_LINES,
  type BffDeps,
  type DeploymentConfigFacts,
  parseGateSteps,
  poolExitGaps,
} from "@maestro/bff";
import { auditVariantModels, createDb } from "@maestro/db";
import { FlowType, type TicketKey } from "@maestro/contracts";
import type { SecretPort } from "@maestro/ports";
import { bootPlatform } from "../boot.js";
import { connectionModelFrom } from "../stores/connection-model.js";
import { variantAwareModelFrom, variantModelReaderFrom } from "../stores/variant-model.js";
import { tlsSkipFlagFrom } from "../stores/connection-tls.js";
import { connectionSecretsFrom } from "../stores/connection-secrets.js";
import { listenAddress, type DeployEnv } from "../env.js";
import { jiraUrlMatchesDriver, workDriverVariableName } from "../profile.js";
import { panelTaniRaporu } from "../tani-panel.js";
import type { KosuSatiri } from "../tani.js";
import { selectIdentityProvider } from "../identity.js";
import { PrismaKillSwitchStore } from "../stores/killswitch.js";
import { PrismaAppRegistryWriter } from "../stores/app-registry-writer.js";
import { PrismaConnectionStore } from "../stores/connections.js";
import { PrismaListeningStore } from "../stores/listening.js";
import { PrismaGuidanceStore } from "../stores/guidance.js";
import { PrismaRunContextStore } from "../stores/run-context.js";
import {
  activeAnalystVariantId,
  activeEngineerVariantId,
  activeTemplateVersion,
  pinnedOr,
} from "../stores/run-pins.js";
import {
  canSearch,
  discoverOnce,
  discoveryStatus,
  startJiraDiscovery,
  type IssueSearcher,
  type KnownRun,
} from "../jira-discovery.js";
import type { ListeningProbeResult } from "@maestro/bff";
import { probeListeningRule } from "../listening-probe.js";
import {
  canReadComments,
  canReadStatuses,
  canReadTickets,
  startJiraPoller,
} from "../jira-poller.js";
import {
  startCommandIntake,
  type CommandIntakeDecision,
  type CommandIntakeHandle,
} from "../command-intake.js";
import {
  intakeLabel,
  listeningBannerLine,
  listeningWarningLine,
  type ClarifyReentryStatus,
} from "../listening-banner.js";
import { EnvGateDirectory } from "../stores/gate-directory.js";
import { checkedOutBranch, prepareWorkspace } from "../stores/workspace-prepare.js";
import type { RepoCloneProbeResult } from "@maestro/bff";
import { EncryptedSecretStore, resolveMasterKey } from "../stores/encrypted-secret.js";
import { PrismaSessionStore } from "../stores/sessions.js";
import { statusMoverFor } from "../stores/status-mover.js";
import {
  LIVE_BINDING_STATES,
  PrismaBindingWriter,
  PrismaJiraProjectBindings,
} from "../stores/bindings.js";
import { PrismaDocTemplateStore } from "../stores/doc-template.js";
import { PrismaParamStore } from "../stores/params-store.js";
import { PrismaRoutingReader } from "../stores/routing.js";
import { PrismaTemplateStore } from "../stores/template.js";
import { assertStoresDurable, volatileStoreWarning, type StoreDurability } from "../stores/durability.js";
import { postgresProbe, temporalProbe } from "../stores/read-health.js";
import { DEGRADED_READ_MODELS, liveReadModels } from "../stores/read-live.js";
import { postgresChainLock, PrismaAuditStore } from "../stores/audit.js";
import { AuditDecisionReader, AuditPiiReader } from "../stores/read-governance.js";
import { PrismaVariantCatalog } from "../stores/read-variants.js";
import { PrismaVariantWriter } from "../stores/write-variants.js";
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
 *
 * Dalga E emptied this of its two most consequential entries. `killSwitch` and
 * `sessions` are now Postgres-backed (`PrismaKillSwitchStore` over the
 * `KillSwitch` table, `PrismaSessionStore` over `Session` — migration 0008), so
 * a restart no longer releases the emergency brake (M58) or signs every user
 * out. The kill switch in particular was the only FATAL entry, so removing it
 * is what lets the prod profile boot with a durable brake rather than refusing.
 *
 * Dalga F emptied the last entry too. The open four-eyes PROPOSAL queue used to
 * be process-local, because a proposal is a value with no approver yet and the
 * `ParamVersion` CHECK (migration 0002) refuses exactly that. It now has its own
 * table — `PendingParamChange` (migration 0013) — so an open proposal (a guarded
 * parameter change OR an onboarding binding) survives a restart. Nothing here is
 * volatile any more; the list is kept as the seam a future volatile store would
 * declare itself through, rather than deleted.
 */
const VOLATILE_STORES: readonly StoreDurability[] = [];

/**
 * The BFF process — the platform's single data door (M7).
 *
 * Boot order is the deployment's dependency order, and every step may refuse:
 * environment, ports, database, Temporal, then the socket. Listening comes
 * last on purpose. A process that accepts a webhook before it can reach the
 * workflow engine answers 200 to a delivery it then drops, and Jira does not
 * redeliver on Maestro's behalf.
 */
/**
 * Kuralın seçtiği ajan artık YOKSA yazılan satır.
 *
 * Sessizce varsayılana düşmek buradaki tehlikeli seçenek: operatör kural
 * ekranında hâlâ sildiği ajanın adını görür ve o ajanın koştuğunu sanır.
 * Satır iki kimliği birden anar, çünkü "hangisi gitti" ile "yerine hangisi
 * koştu" ayrı sorular ve ikisi de cevapsız kalmamalı.
 */
function warnMissingVariant(role: string): (pinnedId: string, used: string) => void {
  return (pinnedId, used) => {
    console.warn(
      `[ajan] Dinleme kuralının seçtiği ${role} ajanı bulunamadı: "${pinnedId}". ` +
        `Koşu kurulum varsayılanıyla açıldı: "${used}". ` +
        `Ajan silinmiş ya da yeniden adlandırılmış olabilir — Dinleme Kuralları ekranından kuralı güncelleyin.`,
    );
  };
}

export async function main(): Promise<void> {
  // The database comes first: the dev profile's pg-blob storage driver writes
  // through it, so the platform cannot be composed without it.
  const url = required(process.env["DATABASE_URL"], "DATABASE_URL");
  const db = createDb(url);

  const { env, deployment, secrets } = await bootPlatform({
    sql: prismaSqlExecutor(db),
    // Same credential resolution as the worker, through the same factory: the
    // connection an admin tests green on this process must be the one the
    // worker's run authenticates with, and two wirings could drift.
    connectionSecrets: connectionSecretsFrom(db),
    // The model itself, from the same panel rows the credential comes from.
    // Both processes resolve it through this one factory so the endpoint an
    // admin tests green in the panel is the one the run dials — the split
    // `connectionSecrets` closed for the token, closed here for the address.
    //
    // Ajan katmanı worker ile AYNI şekilde bağlanır. İki süreç modeli farklı
    // çözerse, adminin panelde denediği ajan run'ın konuştuğu ajan olmaz —
    // `connectionModelFrom`'un tek fabrika olma gerekçesinin aynısı.
    resolveModel: variantAwareModelFrom({
      base: connectionModelFrom(db),
      variants: variantModelReaderFrom(db),
    }),
    // The handshake, from the same panel rows again: a connection whose
    // admin flagged "TLS doğrulamasını atla" is dialled without certificate
    // verification by every adapter, matching the probe that tested it green.
    tlsSkipFlag: tlsSkipFlagFrom(db),
  });

  // Before Temporal, before the socket: a deployment whose emergency brake
  // cannot survive a restart must not reach the point of accepting traffic.
  // Refusing here costs an operator a start-up error; refusing later costs
  // them an incident in which `stop_all` did not stop anything.
  assertStoresDurable(env.profile, VOLATILE_STORES);
  const warning = volatileStoreWarning(VOLATILE_STORES);
  if (warning !== null) console.warn(warning);

  // The run's row is opened here, on the way in, because this is the only
  // place that learns a start actually created an execution. Activities read
  // their context back from that row, so a started workflow without one fails
  // on its first activity — see `TemporalGatewayOptions.onRunOpened`.
  const runContext = new PrismaRunContextStore(db.workflowRun, {
    // ÖNCEKİ KOŞULARIN DEFTERİ — "AI eski yapılanları hatırlasın".
    // İki delege de aynı tabloların dilimleri; mağaza tablonun ne kadarına
    // dokunduğunu kendi arayüzünde yazıyor.
    retired: db.workflowRun,
    journal: db.journalEntry,
  });

  const temporal = await connectTemporal({
    address: required(env.base.TEMPORAL_ADDRESS, "TEMPORAL_ADDRESS"),
    namespace: env.TEMPORAL_NAMESPACE,
    ...(env.TEMPORAL_TASK_QUEUE === undefined ? {} : { taskQueue: env.TEMPORAL_TASK_QUEUE }),
    onRunOpened: async (run) => {
      // Pinned at the start, read once: publishing a new agent version or a new
      // analysis template must not change the rules under a ticket that is
      // already being analysed (M38/M83).
      // Üç iğne, tek turda. `engineerVariantId` bu listeye migration 0022 ile
      // katıldı: `variantId` yalnızca ANALİST'in iğnesiydi (bkz.
      // `activeAnalystVariantId`, rolü açıkça soruyor) ve mühendislik turu da
      // onu okuyordu — yani panelde ayrı bir mühendis ajanı tanımlayan admin,
      // kodu analist ajanının modeliyle yazdırıyordu.
      //
      // KURALIN İĞNESİ ÖNCE, KURULUM VARSAYILANI SONRA. Buradaki `pinnedOr`
      // öncesinde bu satırlar kuralı HİÇ sormuyordu: dinleme kuralında ajan
      // seçilebiliyor, panel yazıyor, BFF okuyordu — ama karar `flowDecisionFor`
      // ile koşu arasında düşüyor ve her koşu `role='analyst'`in ALFABETİK
      // OLARAK İLK satırına iğneleniyordu. Yani "OPS-* ticket'ları kredi
      // analistiyle koşsun" diyen kural yazılabiliyor, sonuç değişmiyordu.
      //
      // Seçmemiş kural aynen eskisi gibi davranır (geriye dönük uyum): ajan
      // seçimi bir daraltmadır, bir kapı değil.
      const [variantId, engineerVariantId, templateVersion] = await Promise.all([
        pinnedOr(db, run.analystVariantId, () => activeAnalystVariantId(db), warnMissingVariant("analist")),
        pinnedOr(db, run.engineerVariantId, () => activeEngineerVariantId(db), warnMissingVariant("mühendis")),
        activeTemplateVersion(db),
      ]);
      // The checkout step 3ö reads. Best-effort: an analysis is worse without
      // it but still correct, and a repository that cannot be cloned must not
      // stop a ticket from being analysed at all — `discoverRepo` already
      // treats a missing session as degraded and carries on.
      const checkout = await checkoutOrNull(env, secrets, run);
      // The branch the PR targets and the clone starts from: the rule's repo
      // map when it named one, else whatever the repository checked out.
      const targetBranch = run.targetBranch ?? checkout?.branch ?? null;
      await runContext.create({
        runId: run.runId,
        ticket: run.ticket,
        appId: run.appId,
        mode: run.mode,
        dataClass: run.dataClass,
        startedAt: new Date(),
        variantId,
        engineerVariantId,
        templateVersion,
        ...(checkout === null ? {} : { workspacePath: checkout.path }),
        ...(targetBranch === null ? {} : { targetBranch }),
      });
    },
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
  // Built BEFORE the read models: the connection rows now feed the health
  // screen too, so the store and the secret side must exist first. Same
  // instances are handed to `deps` below — one store, one cipher, one truth.
  const connections = new PrismaConnectionStore(db.connection);
  const connectorSecrets = new EncryptedSecretStore(
    resolveMasterKey({
      envValue: process.env["CONNECTOR_MASTER_KEY"],
      isProduction: env.profile === "prod",
    }),
    db.connectorSecret,
  );
  const probeRead = liveReadModels({
    db,
    audit: auditStore,
    probes: [postgresProbe(db), temporalProbe(temporal.gateway)],
  });
  // The rehearsal's finding, closed: `/studio/health` reported Postgres and
  // Temporal — the parts a bank is least likely to lose — and said nothing
  // about the LLM key or the Jira credential, the two that actually fail.
  // The connection-backed reader adds llm/jira/scm rows with three honest
  // states, cached on the connection row so a health poll never hammers the
  // provider (see `connectionHealthReader`).
  const read = {
    ...probeRead,
    health: compositeHealthReader([
      probeRead.health,
      connectionHealthReader({ store: connections, secrets: connectorSecrets, fetchImpl: fetch }),
    ]),
  };

  /**
   * The command-intake supervisor, held in a box because the two things that
   * need it are built in the wrong order for a plain binding.
   *
   * `deps` has to READ its status — the wizard asks through
   * `GET /studio/command-intake` — and the supervisor has to be handed `deps`
   * to run commands through. One of the two must therefore be late-bound, and
   * it is this one: the status reader below closes over the box and reads
   * `.current` when the wizard actually asks, exactly as `discoveryRun` closes
   * over its holder for the panel's sweep button.
   */
  const commandIntake: { current?: CommandIntakeHandle } = {};

  /**
   * Panelin "Yapılandırma" bölümünün okuduğu kurulum gerçekleri
   * (`GET /studio/config-health`), aynı geç-bağlama kutusunda.
   *
   * İçindeki her alan bu dosyanın DAHA AŞAĞISINDA hesaplanıyor — tarama
   * zamanlayıcısı, sürücünün yorum/statü yetenekleri, webhook sırrının
   * referansı — ama `deps` burada kuruluyor. `commandIntake` ve `discoveryRun`
   * ile birebir aynı çözüm: kutu şimdi, içi sonra, okuma ise panel gerçekten
   * sorduğunda.
   *
   * Doldurulana kadar `null`: uç bunu "bilinmiyor" satırı olarak gösterir,
   * uydurma bir yeşil olarak değil.
   */
  const deploymentConfig: { current?: DeploymentConfigFacts } = {};

  /**
   * Tek örnek, çünkü İKİ okuyucu var: kapı kararlarının kendisi (`deps.gates`)
   * ve teşhis satırı ("kapı onay grubu eşlenmiş mi"). İkinci bir örnek kurmak,
   * ekranın kararların gerçekte kullandığından başka bir eşlemeyi anlatmasına
   * izin verirdi — ve bir teşhis ekranının yapabileceği en kötü şey budur.
   */
  const gateDirectory = new EnvGateDirectory(env);

  const deps: BffDeps = {
    work: deployment.ports.work,
    workEvents: jiraWorkEventReader(),
    ci: deployment.ci,
    runs: temporal.gateway,
    audit: new AuditChain({
      store: auditStore,
      lock: postgresChainLock(prismaTransactionRunner(db)),
    }),
    // Postgres-backed, where it used to be an `InMemorySessionStore` (Dalga E,
    // migration 0008). A restart no longer signs every logged-in user out
    // mid-task — a support storm on a process that runs under
    // `restart: unless-stopped`. See `PrismaSessionStore` for the timing note
    // on why a primary-key lookup is the right store for a 256-bit token.
    sessions: new PrismaSessionStore(db.session),
    // The login path, selected by config (M8). `local` (default) is the bcrypt
    // provider unchanged; `IDENTITY_DRIVER=ldaps-bind` binds against the bank's
    // AD/LDAP with NO silent fallback to local — an unreachable directory fails
    // the login closed rather than downgrading to a weaker store. The local
    // directory below is both the local provider's store and the default.
    identity: selectIdentityProvider(env, { secrets, users }),
    users,
    // Read from the `JiraProjectBinding` table rather than from a hard-coded
    // empty list. An empty list resolved every project to `null`, so every
    // webhook the bank delivered was accepted and dropped — fail-closed in
    // direction and total in effect, with nothing for an operator to read.
    // An unbound project is still dropped; it now means nobody bound it.
    bindings: new PrismaJiraProjectBindings(db.jiraProjectBinding),
    // Role → directory group. `StaticGateDirectory` answers with the
    // workflow's ROLE names, which a real Jira site does not have: a decision
    // then fails with "group does not exist" (fail-closed, but unusable).
    gates: gateDirectory,
    // Postgres-backed, where it used to be an EMPTY `InMemoryParamStore`.
    // With no definitions at all, every operational setting the installer had
    // seeded into `Param`/`ParamVersion` was invisible: the params screen
    // showed nothing to configure, and the settings, notify and routing
    // screens could not read the escalation ladder, the channel routing or the
    // data-class policy that were in the database the whole time. A restart
    // also silently discarded anything an operator had changed. The pending
    // four-eyes queue is still process-local — see `PrismaParamStore`.
    params: new PrismaParamStore(db.param, db.paramVersion, db.pendingParamChange),
    // Postgres-backed, where it used to be an `InMemoryTemplateStore`.
    //
    // A template version is what an approved analysis was judged against
    // (M83), and holding that in a process-local array meant every restart
    // dropped it: `GET /template` went back to 404 `no_template` and the
    // designer screen back to "henüz yayında değil". That was the last screen
    // in the platform still showing it. Migration 0007 gives it a table, the
    // installer publishes version 1, and the store below is append-only in the
    // same way `PrismaDocTemplateStore` is.
    templates: new PrismaTemplateStore(
      db.analysisTemplateVersion,
      db.jiraProjectBinding,
      db.workflowRun,
    ),
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
    // The LLM triple is passed separately because it is declared by
    // `DeployEnvSchema`, not by `@maestro/config`'s `EnvSchema` — see
    // `LlmWiring`. `LLM_API_KEY_REF` is a SecretPort KEY (`kv/llm#api-key`),
    // a pointer the settings screen may show; the key it resolves to never
    // leaves the process (M9).
    settings: new EnvSettingsReader(env.base, read.health, notifyChannels(deployment), {
      baseUrl: env.LLM_BASE_URL,
      model: env.LLM_MODEL,
      apiKeyRef: env.LLM_API_KEY_REF,
    }),
    routing: new PrismaRoutingReader(db.jiraProjectBinding, db.routingRule, db.application),
    // Postgres-backed, where it used to be an `InMemoryKillSwitchStore` (Dalga
    // E, migration 0008). This is the store `assertStoresDurable` refused a
    // prod boot without: a process-local brake reverts to `off` on the restart
    // this process is configured to perform, RELEASING the emergency brake with
    // nobody told (M58). One durable row now survives it.
    killSwitch: new PrismaKillSwitchStore(db.killSwitch),
    // The connector-management surface (migration 0010): the platform's
    // outbound connections made admin-editable, with tokens stored
    // AES-256-GCM-encrypted. The store persists the connection rows; the
    // EncryptedSecretStore enciphers the tokens under a key from the
    // environment (`CONNECTOR_MASTER_KEY`) — in prod that key is REQUIRED, and
    // in dev a documented key is derived with a warning (never silent). This is
    // its OWN secret port, deliberately not the Vault driver the platform reads
    // deployment secrets through: a console writes here, and must not be able to
    // rewrite the Vault mount the operator manages.
    connections,
    // The M100 app-registry writer: submitting the onboarding wizard registers
    // the picked repo into the `Application` table this reads elsewhere, so a
    // new repo no longer has to be onboarded through another path before it can
    // be bound. The binding itself stays a four-eyes proposal.
    appRegistry: new PrismaAppRegistryWriter(db.application),
    // Turns an APPROVED onboarding proposal into a live JiraProjectBinding (M93).
    // Reader (PrismaJiraProjectBindings) stays resolve-only; both sit on the same
    // table. Without this the approve path would 503-by-name rather than bind.
    bindingWriter: new PrismaBindingWriter(db.jiraProjectBinding),
    // The listening-rules store (Ayarlar > Dinleme Kuralları): status/issuetype
    // → flow-type rows an admin edits from Studio, backing the real DB table.
    listening: new PrismaListeningStore(db.listeningRule),
    /**
     * Alım kararının dökümü: bir satır log'a, tam döküm bir `.md` dosyasına.
     *
     * ── NEDEN DOSYA, NEDEN KOŞU GÜNLÜĞÜ DEĞİL ─────────────────────────────
     * Koşu günlüğü (`JournalEntry`) bir KOŞUYA bağlı, ve bu dökümün cevapladığı
     * asıl vaka koşunun HİÇ AÇILMADIĞI vaka: kural eşleşmedi, akış tam boru
     * hattına düştü, ticket `no_application` ile reddedildi. Öyle bir ticket'ın
     * koşusu yok, dolayısıyla günlüğü de yok — teşhis tam da orada lazım.
     *
     * Kanıt paketi (`evidence/` öneki, nesne deposu) de aday değil: bugün o
     * dosyaları İNDİREN bir uç yok (`Evidence.tsx` bunu kendi başlığında
     * söylüyor), yani oraya yazılan bir döküm operatörün göremeyeceği bir yere
     * yazılmış olurdu. Bir teşhis, teşhis edenin ulaşamadığı yerde durmamalı.
     *
     * Dosya sistemi, `MAESTRO_DECISION_LOG_DIR` ile: operatör `docker compose
     * exec` ile okuyabiliyor, `docker cp` ile alabiliyor, ve dizin bir cilde
     * bağlanmışsa host'tan doğrudan görüyor. Tanımlanmamışsa dosya YAZILMAZ ve
     * yalnızca log satırı çıkar — sessizce bir yere dosya biriktirmek, disk
     * dolduran türden bir sürprizdir.
     */
    decisionLog: decisionLogSink(env.source["MAESTRO_DECISION_LOG_DIR"]),
    guidance: new PrismaGuidanceStore(db.analysisGuidance),
    connectorSecrets,
    // Studio's read side, live (M7). Ten of the twelve read models answer from
    // the tables the worker writes; `runners` and `scans` still refuse by name
    // because nothing in this platform writes either, and a store over an
    // empty table would render "no runners, no findings" — indistinguishable
    // from a healthy fleet. See `stores/read-live.ts`.
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
      // The write side of the same tables (M38/M83). Wiring it turns the
      // admin-gated POST/PUT variant endpoints from 503-by-name into real
      // appends — a variant an admin creates or re-versions in Studio is
      // persisted, not lost at the next restart. Independent of the reader on
      // purpose: a deployment could ship the catalogue without the writer.
      variantWriter: new PrismaVariantWriter(db.variant, db.variantVersion),
      pii: new AuditPiiReader(auditStore, db.llmCall),
      decisions: new AuditDecisionReader(auditStore),
    },
    read,
    // The rules screen shows what SHOULD be picked up; this lets it also say
    // whether anything is looking. See `routes/listening.ts`.
    discoveryStatus,
    /**
     * What the setup wizard reads through `GET /studio/command-intake`.
     *
     * Read through a HOLDER for the same reason `discoveryRun` is: `deps` is
     * built here and the intake supervisor is started further down (it needs
     * the work driver), so this closes over the variable and answers when the
     * wizard actually asks. Until the supervisor exists the answer is the
     * conservative one the route would have produced on its own — webhook-only,
     * no comment reader, restart required — because a wizard that offers
     * polling on an install where nothing polls is the exact failure this whole
     * setting was added to end.
     */
    commandIntakeStatus: () =>
      commandIntake.current?.status() ?? {
        mode: "webhook" as const,
        pollSeconds: 0,
        canReadComments: false,
        appliesLive: false,
        source: "default" as const,
      },
    /**
     * The "şimdi tara" button.
     *
     * `deps` is built here, but the sweep is wired further down (it needs the
     * work driver), so this closes over the holder and reads it when the
     * button is actually pressed. Left undefined until then, which is what the
     * route reports as 503 on a webhook-only install.
     */
    discoveryRun: () =>
      discoveryRun === undefined
        ? Promise.reject(new Error("sweep_not_configured"))
        : discoveryRun(),
    sweepConfigured: () => discoveryRun !== undefined,
    /**
     * "Kuralı test et" — dinleme ekranının provası.
     *
     * `discoveryRun` gibi bir TUTUCU üzerinden okunur: `deps` burada kuruluyor,
     * sürücü aşağıda. Ayrı bir tutucu, çünkü bu ikisi AYNI ŞEY DEĞİL —
     * `JIRA_DISCOVER_MS=0` ile taramayı kapatmış bir kurulumda tur koşmaz ama
     * sürücü hâlâ arayabilir, ve "neden bu ticket gelmiyor" sorusunu sormak
     * taramanın açık olmasına bağlanmamalı. Yokluğunda uç 503-by-name döner.
     */
    listeningProbe: (draft) =>
      listeningProbe === undefined
        ? Promise.resolve({
            ok: false as const,
            reason: "probe_not_available",
          })
        : listeningProbe(draft),
    /**
     * "DEPOYU İNDİRMEYİ DENE" — depo eşlemesi satırının kuru provası.
     *
     * Koşunun klonuyla AYNI kodu (`prepareWorkspace`), AYNI jetonu ve AYNI
     * ortamı kullanır; başka türlüsü "provada indi, koşuda inmedi" der ve
     * provanın anlamı kalmaz. Açtığı klonu siler — bu bir deneme, bir çalışma
     * alanı değil.
     *
     * `WORKSPACE_ROOT` yoksa `undefined` döner ve uç 503-by-name verir:
     * kurulmamış bir keşfi "başarısız" göstermek, operatörü olmayan bir yetki
     * sorununu aramaya gönderirdi.
     */
    ...(((): { repoCloneProbe?: (r: { repo: string; branch?: string }) => Promise<RepoCloneProbeResult> } => {
      const root = env.source["WORKSPACE_ROOT"]?.trim() ?? "";
      if (root === "") return {};
      return {
        repoCloneProbe: async (request) => {
          const tokenRef = env.source["SCM_TOKEN_REF"]?.trim() ?? "";
          const scmHost = env.source["SCM_HOST"]?.trim() ?? "";
          const runId = `deneme-${randomBytes(6).toString("hex")}`;
          const started = Date.now();
          let path: string | null = null;
          try {
            const token = tokenRef === "" ? undefined : await secrets.get(tokenRef);
            path = await prepareWorkspace({
              repo: request.repo,
              root,
              runId,
              ...(request.branch === undefined || request.branch === "" ? {} : { branch: request.branch }),
              ...(scmHost === "" ? {} : { host: scmHost }),
              ...(token === undefined ? {} : { token }),
              timeoutMs: 120_000,
            });
            const [head, count, branch] = await Promise.all([
              gitLine(path, ["log", "-1", "--format=%h %s"]),
              countFiles(path),
              checkedOutBranch(path),
            ]);
            /**
             * BOŞ KLON BAŞARI DEĞİLDİR.
             *
             * `git clone` bir depoya erişemediğinde bile çıkış kodu 0 verip
             * DİZİN BIRAKABİLİR: `.git` kurulmuş, dal adı yazılmış, tek commit
             * yok. Ölçüldü — jetonun erişemediği bir organizasyon deposunda
             * tam olarak bu oldu ve dizin varlığına bakan bir kontrol "indi"
             * der. Operatörün gördüğü şey yine "analiz kodu görmedi" olurdu,
             * bu sefer provanın yeşiline rağmen.
             *
             * Commit yoksa ya da tek dosya inmediyse bu bir başarısızlıktır.
             */
            if (head === null || count === 0) {
              return {
                ok: false,
                repo: request.repo,
                messageKey: "listening.repomap.clone_test.empty",
                ...(branch === null ? {} : { branch }),
                fileCount: count,
              };
            }
            return {
              ok: true,
              repo: request.repo,
              ...(branch === null ? {} : { branch }),
              head,
              fileCount: count,
              durationMs: Date.now() - started,
            };
          } catch (error) {
            /**
             * git'in KENDİ gerekçesi, maskelenmiş.
             *
             * `prepareWorkspace` ham stderr'i bilerek yutar (komut satırı
             * Authorization başlığında jeton taşır) ve geriye "clone failed"
             * kalır — "depo yok", "jeton yetkisiz" ve "CA bozuk" hallerini tek
             * cümlede birleştiren, teşhis edilemez bir mesaj. Burada `cause`
             * açılıp jeton damgalanarak veriliyor; sahada bu üç hali ayırmak
             * saatler aldı.
             */
            const cause = (error as { cause?: unknown }).cause;
            const raw = String((cause as { stderr?: unknown } | undefined)?.stderr ?? cause ?? error);
            const detail = raw
              .replace(/Basic\s+[A-Za-z0-9+/=]+/gu, "Basic ***")
              .replace(/x-access-token:[^@\s]*/gu, "x-access-token:***")
              .replace(/:\/\/[^@\s]*@/gu, "://***@")
              .trim()
              .split("\n")
              .slice(0, 4)
              .join(" ");
            return {
              ok: false,
              repo: request.repo,
              messageKey: "listening.repomap.clone_test.failed",
              ...(detail === "" ? {} : { detail }),
            };
          } finally {
            // Bir deneme, bir çalışma alanı değil: açılan her şey silinir.
            if (path !== null) await rm(path, { recursive: true, force: true }).catch(() => undefined);
          }
        },
      };
    })()),
    /**
     * Which absence it is. The driver check happens further down (it needs the
     * work port), so this reads the holder at call time like the runner does.
     */
    sweepUnavailableReason: () =>
      sweepReason ??
      "Bu kurulumda ticket taraması açık değil. .env dosyasına JIRA_DISCOVER_MS " +
        "ekleyip (örn. 300000) servisleri yeniden başlatın.",
    /**
     * Kurulum gerçekleri, kutudan okunur. Kutu henüz dolmadıysa dolmadığı
     * söylenir — `deploymentConfig` alanının yokluğu ucun "bilinmiyor" cevabına
     * çevirdiği şey, ve o cevap yeşil bir yalandan iyidir.
     */
    deploymentConfig: () =>
      deploymentConfig.current ?? {
        workDriver: deployment.selection.work.driver,
        workDriverVariable: workDriverVariableName(env.source),
        cloudUrlLooksLikeCloud: jiraUrlMatchesDriver(env.source),
        sweepEnabled: false,
        sweepSeconds: 0,
        sweepSource: "varsayilan",
        sweepOffReason: null,
        webhookSecretConfigured: false,
        canMoveStatus: false,
      },
    /**
     * Netleştirme dönüşü — banner'ın yazdığı durumun AYNISI, aynı fonksiyondan.
     * Panel ile boot log'unun bu konuda ayrışabilmesi, teşhis ekranının en
     * pahalıya patlayacak kusuru olurdu.
     */
    clarifyReentryStatus: () => clarifyReentryStatus(),
    /**
     * Ajan modelleri denetimi — `./ajan-modelleri.sh`'in çağırdığı denetimin
     * ta kendisi (`auditVariantModels`), `apply` OLMADAN. Panel hiçbir satırı
     * onarmaz; yalnız raporlar, tıpkı `bin/migrate.ts`in açılışta yaptığı gibi.
     */
    variantModelAudit: async () => {
      const result = await auditVariantModels(db);
      return {
        scanned: result.scanned,
        // Yalnız varyant ADLARI. Model adı operatörün yazdığı serbest bir
        // metindir ve bu yanıtın sözleşmesi kapalı değerlerdir.
        cloudModelVariants: result.findings.map((finding) => finding.variantId),
      };
    },
    /**
     * Panelden indirilen tanı raporu (`GET /studio/tani`).
     *
     * Sayfayı `tani-panel.ts` kuruyor ve `taniHtml`i ÇAĞIRIYOR — betiğin
     * kullandığı üreticinin aynısı, kopyası değil. 1. bölümün bulguları da
     * `buildConfigFindings`ten, yani panelin "Yapılandırma" tablosunu besleyen
     * fonksiyondan geliyor: ekran ile rapor aynı cümleyi söylemek ZORUNDA,
     * yoksa ikisi ayrıştığı gün hangisine inanılacağı bilinmez.
     *
     * SERVİS LOG'LARI YOK ve bu raporun kendi 4. bölümünde adıyla yazılı —
     * gerekçesi `tani-panel.ts`in başındaki nota yazılmış (docker soketi
     * bilerek bağlı değil).
     */
    taniReport: () =>
      panelTaniRaporu({
        // Ucun okuduğu gerçeklerin AYNISI. İki ayrı toplayıcı yazmak, raporun
        // ekrandan farklı bir şey söyleyebilmesi demekti.
        config: async () => ({
          deployment: deploymentConfig.current ?? null,
          intake: commandIntake.current?.status() ?? null,
          /**
           * Kapı onaylarının bir dizin grubuna eşlenip eşlenmediği — dizinin
           * KENDİSİNE sorulan (ortam değişkeni burada yeniden ayrıştırılmıyor,
           * `EnvGateDirectory` tek yorumlayıcı). Raporda da olmalı: panele
           * erişemeyen operatörün elindeki tek teşhis bu dosya.
           */
          gateGroups: await (async () => {
            try {
              const owner = await gateDirectory.ownerOf("4", "");
              return owner.kind === "not_a_gate" ? null : { configured: owner.kind === "group" };
            } catch {
              return null;
            }
          })(),
          clarify: await clarifyReentryStatus(),
          variants: await (async () => {
            const denetim = await auditVariantModels(db);
            return {
              scanned: denetim.scanned,
              cloudModelVariants: denetim.findings.map((finding) => finding.variantId),
            };
          })(),
          /**
           * Statü eşlemesi VE kuralların bot kimliği — TEK okumadan iki gerçek.
           *
           * Kimlik satırının raporda da olması şart: rapor, panele erişemeyen
           * ya da bir destek ticket'ına dosya ekleyen operatörün elindeki tek
           * teşhis. "Kurallar bağlantının bildiği bot hesabından başka bir
           * kimlik taşıyor" cümlesi, bu kurulumun taramasının neden sessizce
           * hiçbir şey bulmadığının cevabı — ve raporda eksik olsaydı, ekranda
           * söylenen şeyi rapor söylemiyor olurdu.
           */
          ...(await (async () => {
            const kurallar = await db.listeningRule.findMany({
              select: {
                statusMapJson: true,
                assigneeAccountId: true,
                allowedStatusesJson: true,
                flowType: true,
                gateStepsJson: true,
                enabled: true,
              },
            });
            // Bağlantıların öğrendiği bot kimliği — `botAccountIdOf`un okuduğu
            // alanın aynısı, burada Prisma satırından. Okunamazsa `null`, ve o
            // "ayrışık" DEĞİL "kıyaslanamadı" demek.
            const botHesabi = await (async () => {
              try {
                const baglantilar = await db.connection.findMany({
                  where: { enabled: true, kind: { in: ["jira_cloud", "jira_dc"] } },
                  select: { configJson: true },
                  orderBy: { id: "asc" },
                });
                for (const baglanti of baglantilar) {
                  const config = baglanti.configJson as Record<string, unknown> | null;
                  const ogrenilen = config?.["botAccountId"];
                  if (typeof ogrenilen === "string" && ogrenilen.trim() !== "") {
                    return ogrenilen.trim();
                  }
                }
              } catch {
                // Okunamadı: bilinmezlik, ayrışma değil.
              }
              return null;
            })();

            const sapma = identityDrift(
              kurallar.map((kural) => ({ assigneeAccountId: kural.assigneeAccountId })),
              botHesabi,
            );

            return {
              statusMaps: {
                ruleCount: kurallar.length,
                mappedRuleCount: kurallar.filter((kural) => kural.statusMapJson != null).length,
                // Havuz çıkışı (bkz. `listening-pool.ts`): yalnız AÇIK kurallar —
                // kapalı kuralın havuzu yok.
                ...(() => {
                  const havuzlu = kurallar
                    .filter((kural) => kural.enabled)
                    .map((kural) => ({
                      allowedStatuses: parseAllowedStatuses(kural.allowedStatusesJson),
                      statusMap: parseStatusMap(kural.statusMapJson),
                      flowType: kural.flowType,
                      gateSteps: parseGateSteps(kural.gateStepsJson),
                    }))
                    .filter((kural) => kural.allowedStatuses !== null);
                  return {
                    poolRuleCount: havuzlu.length,
                    poolWithoutExitCount: havuzlu.filter((kural) => poolExitGaps(kural).length > 0).length,
                  };
                })(),
                /**
                 * KAPI ONAY YOLU — kanalın KENDİ okuyucusundan sayılıyor.
                 *
                 * `parseStatusMap` + `gateStatusesOf` zinciri, uçtaki
                 * `studio-ops.ts`in kullandığının aynısı. Burada elle
                 * `statusMapJson.gateApproveStatus != null` demek, bir kural
                 * çakışık olduğu için düşürülmüşken onu "açık" saymak olurdu —
                 * ve rapor ile ekranın ayrışması, bu satırın kapatmaya geldiği
                 * sessizliğin ta kendisi.
                 */
                ...(() => {
                  const haritalar = kurallar.map((kural) => parseStatusMap(kural.statusMapJson));
                  const kapilar = haritalar.map((harita) => gateStatusesOf(harita));
                  return {
                    gateStatusRuleCount: kapilar.filter(
                      (kapi) => kapi.approve !== null || kapi.return !== null,
                    ).length,
                    gateStatusConflictCount: kapilar.filter((kapi) => kapi.conflicts.length > 0).length,
                  };
                })(),
              },
              ruleIdentity: {
                ruleCount: kurallar.length,
                staleRuleCount: sapma.staleRuleCount,
                staleAccountCount: sapma.staleAccountIds.length,
                internalKeyRuleCount: sapma.internalKeyRuleCount,
                connectionKnown: sapma.connectionAccountId !== null,
              },
            };
          })()),
        }),
        akis: {
          toplam: () => db.workflowRun.count(),
          adimDagilimi: async () =>
            (await db.workflowRun.groupBy({ by: ["step"], _count: { _all: true } }))
              .map((grup) => [grup.step, grup._count._all] as const)
              .sort((sol, sag) => sol[0].localeCompare(sag[0])),
          // 2b = netleştirme kapısı. BİTMİŞ koşular dışarıda: 2b'den geçip
          // tamamlanmış bir koşu cevap beklemiyor.
          netlestirmeBekleyen: async () =>
            (
              await db.workflowRun.findMany({
                where: { step: "2b", status: { in: ["running", "gate", "queued"] } },
                orderBy: { updatedAt: "desc" },
                take: 100,
              })
            ).map(kosuSatiri),
          sonKosular: async () =>
            (await db.workflowRun.findMany({ orderBy: { updatedAt: "desc" }, take: 40 })).map(
              kosuSatiri,
            ),
          // BFF'in kendi geçidi: "açık workflow" tanımının ikinci bir istemcide
          // ayrışmasına kapı bırakmamak için.
          temporalAcik: async () => (await temporal.gateway.list({ onlyRunning: true, limit: 200 })).length,
          /**
           * KAYIP KOŞU KIYASININ İKİ TARAFI.
           *
           * Veritabanına göre bekleyen her koşunun Temporal'da bir execution'ı
           * OLMALI. Olmayanı uyandırılamaz ve dışarıdan hiçbir belirtisi yok:
           * panel satırı "running" der, ticket kapıda durur, `/approve` yazan
           * operatör hiçbir cevap alamaz.
           *
           * Bu kurulumda ölçüldü: 14 "running" satıra karşı Temporal'da 2 açık
           * execution, ve aradaki 12 koşu 4/5 kapısında bekliyordu. Sebep,
           * Temporal'ın varsayılan 24 saatlik saklama süresinin bu ürünün
           * akışından (günler — M61 kapıları SÜRESİZ bekler) kısa olması.
           */
          bekleyenKosular: async () =>
            (
              await db.workflowRun.findMany({
                where: { status: { notIn: ["done", "cancelled"] } },
                orderBy: { updatedAt: "desc" },
                take: 200,
              })
            ).map(kosuSatiri),
          acikTicketlar: async () =>
            new Set(
              (await temporal.gateway.list({ onlyRunning: true, limit: 200 })).map(
                (kosu) => kosu.ticketKey,
              ),
            ),
          saklamaSaniye: () => temporal.gateway.saklamaSaniye(),
        },
        hostAdi: env.source["HOSTNAME"] ?? "(bilinmiyor)",
        imajSurumu: env.source["MAESTRO_IMAGE_TAG"] ?? "(bilinmiyor)",
        now: () => new Date(),
      }),
    config: {
      env: env.base,
      /**
       * What a ticket does when NO listening rule claims it.
       *
       * A per-ticket rule is the real answer and it wins outright
       * (`apps/bff/src/flow-decision.ts`); this only decides the leftovers. It
       * used to be derived from the profile — `analiz` meant every unclaimed
       * ticket was analysis-only — which is precisely the deployment-time
       * switch that made the wizard's offer a lie. The profile no longer knows
       * what a run is for, so nothing here derives it.
       *
       * `MAESTRO_FLOW` still names a fallback for a site that wants one, and
       * absent it the answer is the full pipeline. Unset is the honest default
       * now that the engineering ports compose everywhere: a run that reaches
       * them and has no repository connection fails with a sentence naming the
       * connection, and the wizard says so before anybody commits.
       */
      ...(flowOf(env) === null ? {} : { defaultFlow: flowOf(env) }),
    },
  };

  /**
   * HOW ticket commands reach this deployment (`command-intake.ts`).
   *
   * `/approve` and `/reject <sebep>` arrive as ticket comments, and there are
   * exactly two ways to read one: Jira calls us (`POST /webhooks/jira`), or we
   * ask Jira (`jira-poller.ts`). WEBHOOK IS PRIMARY on both Jira drivers — each
   * verifies a signed delivery — and a deployment whose webhook arrives does
   * not need the loop.
   *
   * The loop is the only remaining way in for the deployment where the call
   * never ARRIVES: a Data Center inside a corporate network with no outbound
   * route to Maestro, or a Cloud site where no webhook was ever registered.
   * There, `/approve` written on the ticket reaches nothing without it and the
   * gate waits forever.
   *
   * Running BOTH is safe rather than double-counted: the loop de-dupes by
   * author+timestamp within the process, and behind it `decideGate` refuses a
   * decision on a gate that is already closed — so a comment the webhook
   * already answered costs a logged refusal, never a second approval.
   *
   * WHICH of the three runs is no longer decided here. It used to be read once,
   * at boot, out of `JIRA_POLL_MS` — an environment variable, in a file, on a
   * server a bank operator has no shell on. The answer now comes from a
   * parameter the setup wizard asks for in words, and `startCommandIntake`
   * SUPERVISES it: the stored answer is re-read on a timer and the poller is
   * started, stopped or re-intervalled to match, so a change saved from the
   * panel applies without a container restart. `JIRA_POLL_MS` survives as the
   * boot-time default for installs that already set it — see
   * `resolveCommandIntake` for the precedence and why it is that way round.
   */
  const commentReader = canReadComments(deployment.ports.work) ? deployment.ports.work : null;
  /**
   * Ticket'ın mevcut atananını okuyabilen sürücü — netleştirmeye yeniden
   * girişin webhook'suz kanalı (`clarifyReentry`).
   *
   * `canReadComments` ile aynı desen ve aynı gerekçe: bir yapısal kontrol,
   * `as unknown as` ile bir kast değil. `getTicket` `WorkPort`'un kendisinde
   * var, yani her iki Jira sürücüsü de bunu karşılıyor — ama Azure DevOps'un
   * hâlâ bir iş portu yok, ve kontrol o yüzden gerçek kalıyor.
   */
  const ticketReader = canReadTickets(deployment.ports.work) ? deployment.ports.work : null;

  /**
   * Ticket'ın STATÜSÜNÜ okuyabilen sürücü — kapı kararının yoklama kanalı.
   *
   * `ticketReader`dan AYRI bir kontrol, ve ayrı olması gerekiyor: `getTicket`
   * `WorkPort`'un kendisinde, `readCurrentStatus` ise sürücüye özgü bir
   * yetenek (donmuş `TicketSnapshot` statü taşımıyor). İkisi aynı sürücüde
   * bulunuyor olsa da, biri varken diğerinin olduğunu VARSAYMAK tam olarak
   * `as unknown as` kastının yaptığı hata olurdu.
   */
  const statusReader = canReadStatuses(deployment.ports.work) ? deployment.ports.work : null;

  /**
   * Motorun Jira kimliği, HER SORULDUĞUNDA yeniden çözülür.
   *
   * `MAESTRO_BOT_ACCOUNT_ID`, o boşsa panelde bağlantı testinin öğrendiği
   * kimlik. Kural ve gerekçesi tek yerde: `@maestro/bff`'in `bot-identity.ts`
   * dosyası — düşüş yalnız .env boşken yapılır, çünkü ayrışma ancak dolu
   * olduğunda mümkündür.
   *
   * Boot'ta bir kez değil her çağrıda okunuyor: operatör bağlantı testini
   * kurulumdan sonra yapıyor, ve bir yeniden başlatmayı beklemek bu kanalın
   * "yeşil görünüp kapalı kalması" demek olurdu.
   */
  const resolveEngineIdentity = async (): Promise<string | null> =>
    (await resolveBotIdentity(env.source["MAESTRO_BOT_ACCOUNT_ID"] ?? "", connections))?.accountId ?? null;

  /**
   * The BANNER, printed before the first round.
   *
   * This is the line to ask an operator for when they report that listening
   * does not work: it names the driver, the endpoint Jira has to reach, what is
   * in force, where that answer came from, and whether the driver can read a
   * comment at all. See `listening-banner.ts` for why each of those five is on
   * it and why no secret is.
   */
  const bannerFor = async (intake: CommandIntakeDecision): Promise<void> => {
    const banner = {
      driver: deployment.selection.work.driver,
      canReadComments: commentReader !== null,
      webhookPath: "/webhooks/jira",
      intake,
      clarifyReentry: await clarifyReentryStatus(),
    };
    console.info(listeningBannerLine(banner));
    const warning = listeningWarningLine(banner);
    if (warning !== null) console.warn(warning);
  };

  /**
   * Yeniden giriş kanalının banner'a yazılacak hâli.
   *
   * Sıra ÖNEMLİ: ticket okuyucusunun yokluğu önce sorulur, çünkü o durumda
   * kimlik doğru olsa bile yoklama kanalı kurulamaz — operatöre önce
   * düzeltebileceği şeyi söylemek, düzeltemeyeceğinin ardına saklamaktan
   * iyidir. Kimlik ise ikinci: onu panelde bir tıkla açabiliyor.
   *
   * NOT: bu, YOKLAMA kanalının durumudur. Webhook yolu (`clarify-reentry.ts`)
   * ticket okuyucusuna ihtiyaç duymaz — olayın kendisi atananı taşır — ama bot
   * kimliğine ikisi de muhtaçtır, ve kapalılığın asıl sessiz sebebi odur.
   */
  const clarifyReentryStatus = async (): Promise<ClarifyReentryStatus> => {
    const identity = await resolveBotIdentity(env.source["MAESTRO_BOT_ACCOUNT_ID"] ?? "", connections);
    if (identity === null) return { state: "closed", reason: "no_bot_account" };
    if (ticketReader === null) return { state: "closed", reason: "no_ticket_reader" };
    return { state: "open", source: identity.source };
  };

  /** What the banner last announced, so a LIVE change prints a delta and not a repeat. */
  let announced: CommandIntakeDecision | null = null;

  commandIntake.current = startCommandIntake({
    /**
     * The two parameters, re-read EVERY round. That is what makes the setting
     * apply without a restart, and it is the whole reason the supervisor exists.
     */
    readStored: async () => {
      const [mode, seconds] = await Promise.all([
        db.paramVersion.findFirst({
          where: { key: "jira.command_intake" },
          orderBy: { version: "desc" },
        }),
        db.paramVersion.findFirst({
          where: { key: "jira.poll_seconds" },
          orderBy: { version: "desc" },
        }),
      ]);
      return { mode: mode?.valueJson, pollSeconds: seconds?.valueJson };
    },
    // Backwards compatibility: with no stored answer this variable still
    // decides, so an install that has been polling since before the setting
    // existed keeps polling after the upgrade.
    envPollMs: env.source["JIRA_POLL_MS"],
    // The server-side lock: a driver with no comment reader never polls, no
    // matter what is stored. Asked once — a driver does not grow a method at
    // runtime — and reported honestly on the status the wizard reads.
    canReadComments: commentReader !== null,
    startPoller: (intervalMs) =>
      startJiraPoller({
        deps: resolveDeps(deps),
        // The concrete driver: reading a thread is not on `WorkPort`. Asked for
        // by name rather than cast — see `canReadComments`. Non-null by
        // construction: `startPoller` is only called when the flag above is true.
        comments: commentReader as NonNullable<typeof commentReader>,
        // Netleştirme yeniden girişi: ikisi de varsa açık, yoksa o kanal
        // bu kurulumda yok (webhook'u çalışan bir kurulumda zaten gerekmez).
        ...(ticketReader === null ? {} : { tickets: ticketReader }),
        // Kapı kararının statüyle verilmesi: sürücü statü okuyabiliyorsa
        // açık, okuyamıyorsa bu kurulumda o kanal YOK ve `/approve` tek yol.
        ...(statusReader === null ? {} : { statuses: statusReader }),
        botAccountId: resolveEngineIdentity,
        intervalMs,
        // Live runs, re-read each round so a gate opened a second ago is polled
        // without waiting for a restart.
        openTickets: async () =>
          (
            await db.workflowRun.findMany({
              where: { status: { notIn: ["done", "cancelled"] } },
              orderBy: { startedAt: "desc" },
              take: 50,
            })
          ).map((row) => row.ticketKey as TicketKey),
      }),
    /**
     * Every decision the supervisor takes, said out loud — but only when it
     * CHANGED.
     *
     * The first call is the boot banner. Every later one is an operator having
     * saved a different answer in the panel, and printing the transition is
     * what lets them verify from the log that their click took effect. Printing
     * the unchanged answer every thirty seconds would bury it.
     */
    onDecision: (intake) => {
      if (announced === null) {
        announced = intake;
        void bannerFor(intake);
        return;
      }
      if (
        announced.mode === intake.mode &&
        announced.pollSeconds === intake.pollSeconds &&
        announced.source === intake.source
      ) {
        return;
      }
      console.info(
        `[dinleme] komut alımı değişti: ${intakeLabel(announced)} → ${intakeLabel(intake)} ` +
          `(kaynak: ${intake.source === "param" ? "panel" : intake.source === "env" ? "JIRA_POLL_MS" : "varsayılan"})`,
      );
      announced = intake;
    },
  });

  /**
   * Ticket DISCOVERY (`jira-discovery.ts`).
   *
   * Separate from the comment poller above, and for a different failure: that
   * one reads `/approve` on tickets the platform already has, this one finds
   * the tickets in the first place. Without it a ticket reaches Maestro only
   * through a Jira webhook or somebody typing `/ai-start` — and on an install
   * where neither is set up, the product looks broken in the most confusing way
   * available: panel up, connection green, rules correct, no tickets ever.
   *
   * Own interval so the two can be tuned apart: comments are cheap and want to
   * be quick, a JQL sweep is not and does not.
   */
  /**
   * Set only when the sweep is configured, so the panel's button can tell
   * "nothing happened" from "there is nothing to run" (503).
   */
  let discoveryRun: (() => Promise<readonly string[]>) | undefined;
  /** Set when the sweep is impossible for a reason other than "not asked for". */
  let sweepReason: string | undefined;
  /**
   * "Kuralı test et" provası — TARAMADAN AYRI kurulur.
   *
   * Kasıtlı olarak `discoveryRun` ile aynı koşula bağlı değil. Taramayı
   * `JIRA_DISCOVER_MS=0` ile kapatmış (ya da webhook'la çalışan) bir kurulumda
   * tur koşmaz, ama sürücü hâlâ JQL arayabilir — ve "yazdığım kural neyle
   * eşleşiyor" sorusu tam da o kurulumlarda soruluyor. Tek şartı sürücünün
   * arama sunması.
   */
  let listeningProbe:
    | ((draft: {
        readonly projectKey: string;
        readonly assigneeAccountId: string;
        readonly matchKind: "status" | "issuetype" | "assigned" | "label";
        readonly matchValue: string;
        readonly allowedStatuses?: readonly string[] | null;
      }) => Promise<ListeningProbeResult>)
    | undefined;
  /**
   * The driver's searcher, or nothing.
   *
   * This used to be `ports.work as unknown as IssueSearcher` — a cast
   * TypeScript accepts and the runtime does not. Asked, not asserted, so a
   * driver that cannot be swept is reported instead of failing once per
   * interval.
   *
   * Both Jira drivers answer this now. It used to be Cloud only, and on Data
   * Center the consequence was not "no sweep" but "no way in AT ALL" — see
   * `packages/adapter-jira/src/search.ts` for the three-way deadlock that
   * created and why DC's `/rest/api/2/search` always could have broken it.
   * The check stays real because Azure DevOps still has no work port.
   */
  const workPort: unknown = deployment.ports.work;
  const searcher: IssueSearcher | null = canSearch(workPort) ? workPort : null;

  /**
   * BAĞLI VE CANLI PROJELER — hem turun hem provanın dış sınırı, TEK kaynaktan.
   *
   * İkisi ayrı yazılsaydı er ya da geç "bağlı" kelimesinin iki farklı anlamına
   * kayarlardı: `paused` bir bağlantı turda dışarıda kalıp denemede içeride
   * olurdu ve panel, sahada hiç aranmayacak bir kuralı yeşil gösterirdi.
   */
  const liveBoundProjects = async (): Promise<readonly string[]> =>
    (
      await db.jiraProjectBinding.findMany({
        where: { state: { in: LIVE_BINDING_STATES as never } },
        select: { projectKey: true },
      })
    ).map((row) => row.projectKey);

  /** Koşusu olan ticket anahtarları — turda "başlatma", denemede "işaretle". */
  const knownTickets = async (): Promise<readonly TicketKey[]> =>
    (await db.workflowRun.findMany({ select: { ticketKey: true }, take: 500 })).map(
      (row) => row.ticketKey as TicketKey,
    );

  /**
   * Aynı satırlar, koşunun NEREDE olduğuyla birlikte — tarama turu için.
   *
   * `select` iki alan genişliyor, sorgu sayısı AYNI kalıyor: `step` ve `status`
   * zaten `WorkflowRun` satırında duruyor. Karşılığında tarama, atladığı her
   * ticket için "koşusu var (kapıda bekliyor, adım 5)" yazabiliyor — operatörün
   * "koşusu zaten var" satırını "sistem beni duymuyor" diye okumasının çaresi.
   *
   * Deneme (`listeningProbe`) düz `knownTickets`i kullanmaya devam ediyor:
   * orada ekran zaten "Bu zaten alınmış" rozetini basıyor ve adım bilgisi o
   * tabloya ait bir sütun değil.
   */
  const knownRuns = async (): Promise<readonly KnownRun[]> =>
    (
      await db.workflowRun.findMany({
        select: { ticketKey: true, step: true, status: true, updatedAt: true },
        /**
         * EMEKLİYE AYRILMIŞ SATIRLAR SAYILMAZ — ve bu, `take: 500` yüzünden
         * bir kolaylık değil bir DOĞRULUK meselesi.
         *
         * Yeniden başlatma eski satırı emekliye ayırır (`RunCatalog.retire`):
         * satır durur, kimliği değişir, `archivedAt` dolar. Ticket'ın CANLI
         * satırı ise yenisi, ve tarama zaten onu görüp atlayacak — yani emekli
         * satırı ayrıca saymanın bir faydası yok.
         *
         * Zararı ise var: bu sorgu 500 satırda kesiliyor. İki kez yeniden
         * başlatılmış bir kurulumda emekli satırlar bütçeyi yiyip GERÇEKTEN
         * koşusu olan ticket'ları listenin dışında bırakabilir — ve listenin
         * dışında kalan ticket, koşusu olduğu hâlde ikinci kez başlatılır.
         * Yani kesme, düzeltilen hatanın aynısını ters yönden üretirdi.
         *
         * `archivedAt` elle arşivlenmiş satırları da dışarıda bırakır ve bu
         * DOĞRU: arşivlemek "bu satırla işim bitti" demek, ve o ticket yeniden
         * eşleşirse yeniden alınması operatörün kendi kararının sonucudur.
         */
        where: { archivedAt: null },
        // En taze satırlar önce: kesme yine de devreye girerse, kaybedilen
        // satırlar en eskiler olur — yani en az ihtimalle yeniden eşleşecekler.
        orderBy: { updatedAt: "desc" },
        take: 500,
      })
    ).map((row) => ({
      ticket: row.ticketKey as TicketKey,
      step: row.step,
      status: String(row.status),
    }));

  /**
   * Prova, sürücü arayabiliyorsa kurulur — tarama açık olsun ya da olmasın.
   * Gerekçesi `listeningProbe` bildiriminde.
   */
  if (searcher !== null) {
    listeningProbe = async (draft) =>
      probeListeningRule(
        { search: searcher, boundProjects: liveBoundProjects, known: knownTickets },
        draft,
      );
  }

  /**
   * The sweep interval, and WHERE it came from.
   *
   * ── Why there is a default at all ────────────────────────────────────────
   * This codebase's standing rule is that a silent default is worse than an
   * absent feature, and the rule is right nearly everywhere. It is wrong here,
   * and the field proved it: on a closed-network Data Center no webhook can be
   * registered, so the sweep is not an optimisation over the webhook — it is
   * the ONLY door a ticket can come through. Leaving it off by default meant
   * shipping an install whose every green light was truthful and which could
   * never start a single run. "Varsayılan kapalı" was the operator's own
   * description of the fault.
   *
   * So the default is ON, and the cost of being wrong is bounded in a way the
   * old default's was not: a sweep nobody needed costs one JQL query per rule
   * every five minutes against a Jira that is already answering this platform's
   * writes, and `runIntake` is idempotent per ticket so an overlap with a
   * working webhook starts nothing twice.
   *
   * ── What keeps it from being SILENT ──────────────────────────────────────
   * The source travels with the value and is printed at boot. An operator
   * reading the log is told the sweep is on, at what interval, and that nobody
   * configured it — which is precisely the sentence whose absence made the
   * previous behaviour a defect rather than a choice.
   *
   * `JIRA_DISCOVER_MS=0` still means OFF, explicitly. The default may not
   * override a written answer, including a written "no".
   */
  const discoverRaw = env.source["JIRA_DISCOVER_MS"]?.trim() ?? "";
  const discoverEnvMs = Number(discoverRaw);
  const discoverConfigured = discoverRaw.length > 0 && Number.isFinite(discoverEnvMs);
  /** Five minutes: gentle on a bank's Jira, and a worst case of 5 min to intake. */
  const DEFAULT_DISCOVER_MS = 300_000;
  const discoverMs = discoverConfigured ? discoverEnvMs : DEFAULT_DISCOVER_MS;
  const discoverSource = discoverConfigured ? "JIRA_DISCOVER_MS" : "varsayılan";

  if (Number.isFinite(discoverMs) && discoverMs > 0 && searcher !== null) {
    /**
     * Built once and used twice: the timer loop below, and the panel's "şimdi
     * tara" button. Sharing the object is the point — a manual sweep that
     * searched with different rules or a different driver would test something
     * other than what runs on the timer, which is the one thing a test button
     * must never do.
     */
    const discoveryOptions = {
      deps: resolveDeps(deps),
      search: searcher,
      intervalMs: discoverMs,
      rules: async () =>
        (await db.listeningRule.findMany({ orderBy: { priority: "asc" } })).map((row) => ({
          projectKey: row.projectKey,
          assigneeAccountId: row.assigneeAccountId,
          matchKind: row.matchKind as "status" | "issuetype" | "assigned" | "label",
          matchValue: row.matchValue,
          // STATÜ KAPISI, sorguya girmek üzere (0024). Kolonu doğrulamadan
          // geçirmek, elle yazılmış bir jsonb'nin JQL'e sızması demek olurdu;
          // `parseAllowedStatuses` bozuk değeri `null`'a — yani "kısıt yok"a —
          // indirir ve `jqlFor` o durumda statü yan tümcesi eklemez.
          allowedStatuses: parseAllowedStatuses(row.allowedStatusesJson, (reason) =>
            console.warn(
              `[maestro] dinleme kuralı ${row.ruleId}: allowedStatusesJson okunamadı ` +
                `(${reason}) — tarama bu kuralı STATÜ KISITI OLMADAN arayacak.`,
            ),
          ),
          enabled: row.enabled,
        })),
      /**
       * THE PROJECTS AN OPERATOR ACTUALLY BOUND — the sweep's outer boundary.
       *
       * A listening rule names its project as free text; this table is where an
       * operator SAID "this project is Maestro's". When the two disagree the
       * table wins, and the query for a rule pointing anywhere else is never
       * sent. It matters because this platform's Jira service account is
       * routinely an ADMIN: an unbound project is not merely out of scope, it
       * is another team's tickets that a stray rule would otherwise read.
       *
       * `LIVE_BINDING_STATES` rather than "row exists": a `paused` or `dry_run`
       * binding is deliberately NOT live, and a paused project must stop being
       * swept the moment it is paused — the same list `PrismaJiraProjectBindings`
       * uses for `active`, so the sweep gate and the intake gate cannot drift
       * into disagreeing about what "bound" means.
       */
      boundProjects: liveBoundProjects,
      /**
       * The operator's interval, from `jira.discover_seconds`.
       *
       * Read from the parameter table rather than the environment so it can be
       * changed from the panel and take effect on the NEXT round — on a bank's
       * server a container restart is a change request, not a click.
       *
       * A missing row (or a value that is not a number) answers null, which
       * the loop reads as "keep the boot default".
       */
      intervalSeconds: async () => {
        const row = await db.paramVersion.findFirst({
          where: { key: "jira.discover_seconds" },
          orderBy: { version: "desc" },
        });
        const value = row?.valueJson;
        return typeof value === "number" && Number.isFinite(value) ? value : null;
      },
      // Every ticket that already has a row, in ANY state: a finished run must
      // not be started again by the next sweep. Koşunun ADIMIYLA birlikte, ki
      // atlama satırı koşunun yaşadığını da söyleyebilsin — ve koşusu ÖLMÜŞ
      // olanlar `liveRuns`/`restart` ile otomatik yeniden akışa alınsın.
      known: knownRuns,
      /**
       * MOTORDA YAŞAYAN KOŞULAR — tur başına TEK sorgu.
       *
       * `RunGateway.list()` motorun tuttuğu execution'ları bir sayfada verir;
       * turun ihtiyacı olan tek şey oradaki ticket anahtarları. Ticket başına
       * `queryRunState` sormak, havuzda yüz ticket olan bir kurulumda her
       * turda yüz gRPC çağrısı demekti — `reconcileRunStatuses` aynı soruyu
       * aynı toplu okumayla soruyor ve iki yol ayrılmamalı.
       *
       * `onlyRunning: false`: kapanmış bir execution da motorun tanıdığı bir
       * koşudur, ve "motor bu ticket'ı tanımıyor" ile "koşu bitti" farklı iki
       * şey. Kapanmış koşu zaten `WorkflowRun.status` terminal olduğu için
       * kuralla eşleşmez; burada onu ölü saymak, biten bir işi yeniden
       * başlatmak olurdu.
       *
       * `limit` `knownRuns`in `take: 500`üyle aynı: iki listenin ufku ayrılırsa
       * ufkun dışında kalan koşular "motorda yok" görünür ve yeniden
       * başlatılırdı.
       */
      liveRuns: async (): Promise<ReadonlySet<string>> =>
        new Set(
          (await temporal.gateway.list({ limit: 500, onlyRunning: false })).map(
            (summary) => summary.ticketKey,
          ),
        ),
      /**
       * YENİDEN BAŞLATMA — elle düğmenin kullandığı YOLUN AYNISI.
       *
       * `restartDeadRun` emekliye ayırır (satır terminale çekilip arşivlenir;
       * defter/adım/kanıt/kapı yazıldıkları kimlikte olduğu gibi kalır — kimliği
       * değiştirmek defterin yalnızca-ekleme korumasına çarpıyordu), denetime
       * yazar, ve `runIntake` ile
       * ticket'ı yeniden alır. İkinci bir mekanizma yazmak, alımın zayıf bir
       * kopyasını üretmek olurdu.
       *
       * `auditActor` = `intakeActor` = `SYSTEM_ACTOR`: bunu bir insan değil
       * zamanlayıcı yaptı, ve denetim kaydı bunu `source: "sweep"` ile ayrıca
       * söylüyor.
       */
      restart: {
        priorRestarts: async (ticket: TicketKey): Promise<number> => {
          // Pencereli sayım (bkz. `stuck.restart_window_hours`): pencere
          // dışındaki eski yeniden başlatmalar freni doldurmaz — düzeltilmiş
          // bir sistem ertesi gün yeniden dener, ticket havuzda çürümez.
          const row = await db.paramVersion.findFirst({
            where: { key: "stuck.restart_window_hours" },
            orderBy: { version: "desc" },
          });
          const hours = typeof row?.valueJson === "number" && row.valueJson > 0 ? row.valueJson : 24;
          const since = new Date(Date.now() - hours * 60 * 60 * 1000);
          return db.workflowRun.count({
            where: { ticketKey: ticket, archivedAt: { not: null, gte: since } },
          });
        },
        restart: async (ticket: TicketKey) => {
          const result = await restartDeadRun(resolveDeps(deps), {
            ticket,
            auditActor: SYSTEM_ACTOR,
            intakeActor: SYSTEM_ACTOR,
            source: "sweep",
            onSnapshotError: (error) =>
              console.warn(
                `[maestro] ${ticket} yeniden başlatılırken ticket okunamadı: ${String(error)}`,
              ),
          });
          if (!result.ok) return null;
          return {
            attempt: result.attempt,
            accepted: result.outcome.accepted,
            ...(result.outcome.accepted ? {} : { reason: result.outcome.reason }),
          };
        },
      },
    };
    startJiraDiscovery(discoveryOptions);
    // The panel's button runs ONE round with the same options; it does not
    // touch the timer, so pressing it never changes the schedule.
    discoveryRun = async () => discoverOnce(discoveryOptions);
    console.info(
      `[maestro] ticket taraması AÇIK — her ${Math.round(discoverMs / 1000)} sn ` +
        `(kaynak: ${discoverSource}). Yeni ticket'lar dinleme kurallarından üretilen ` +
        "JQL ile bulunur; webhook'suz kurulumda bir ticket'ın akışa girmesinin tek yolu budur." +
        (discoverConfigured
          ? ""
          : " Bu değeri kimse yazmadı: kapatmak için .env'e JIRA_DISCOVER_MS=0 ekleyin."),
    );
  } else if (Number.isFinite(discoverMs) && discoverMs > 0) {
    /**
     * Asked for, and impossible.
     *
     * An operator who set `JIRA_DISCOVER_MS` expects a sweep; a driver with no
     * search cannot give one. Staying silent here is what produced the original
     * complaint — the panel said the sweep was on, every round threw, and
     * nothing in the log connected the two. Said at boot instead, once, by
     * name.
     */
    /**
     * Aranamayan bir sürücü. İki Jira sürücüsü de arama sunduğuna göre bu,
     * pratikte iş portu olmayan bir kurulum demektir (Azure DevOps) — ve o
     * kurulumda ticket'ın girebileceği başka bir kapı olduğunu SÖYLEMEK
     * gerekir, yoksa operatör düzeltilecek bir ayar arar ve bulamaz.
     */
    sweepReason =
      "Bu kurulumun iş sürücüsü ticket araması sunmuyor, bu yüzden tarama " +
      "çalışamaz. Arama Jira Cloud ve Jira Data Center sürücülerinde vardır; " +
      "kurulu sürücü bunlardan biri değil. Bağlantılar ekranından Jira " +
      "bağlantısını kontrol edin.";
    console.warn(
      `[maestro] ticket taraması KAPALI — istendi (${discoverMs} ms, kaynak: ${discoverSource}) ama ` +
        "bu iş sürücüsü arama sunmuyor. Arama Jira Cloud ve Jira Data Center " +
        "sürücülerinde vardır; kurulu sürücü bunlardan biri değil. Bu kurulumda " +
        "ticket'lar yalnız webhook ile ya da panelden elle girebilir.",
    );
  } else if (searcher !== null) {
    /**
     * The third case, and the one that was SILENT.
     *
     * The driver CAN sweep and nobody asked it to: `JIRA_DISCOVER_MS` is empty
     * or zero. Until this line existed the boot log said nothing at all about
     * the sweep in this state — no "açık" line, no "İSTENDİ ama olmuyor" line
     * — so the operator who then pressed "Şimdi tara" got a 503 whose reason
     * appeared nowhere in the log they had already collected. Two absences that
     * need two different fixes (`JIRA_DISCOVER_MS` versus a Cloud connection)
     * produced the same evidence: nothing.
     *
     * A notice rather than a warning: a webhook-driven install is a legitimate,
     * common configuration and this is not a fault. It is here so the log can
     * ANSWER the question the panel's 503 raises.
     */
    /**
     * Tarama, AÇIKÇA kapatılmış: `JIRA_DISCOVER_MS=0`. Artık tek yolu bu —
     * varsayılan açık olduğu için "boş bıraktım" bu dala hiç düşmüyor.
     *
     * Uyarı olarak yazılıyor, bilgi olarak değil: webhook'u olmayan bir
     * kurulumda bu satır "hiçbir ticket asla girmeyecek" demektir, ve
     * operatörün bunu boot log'unda görmesi gerekir.
     */
    console.warn(
      "[maestro] ticket taraması KAPALI — .env'de JIRA_DISCOVER_MS=0 yazıyor. Bu sürücü " +
        "arama SUNUYOR, yani kapalılık bir kısıt değil bir tercih. Jira webhook'u da " +
        "kurulmadıysa hiçbir ticket akışa GİREMEZ: panel açık, bağlantı yeşil ve hiç koşu " +
        "başlamaz. Açmak için satırı silin ya da JIRA_DISCOVER_MS=300000 (5 dk) yazın.",
    );
  }

  /**
   * Kutuyu doldur — panelin "Yapılandırma" bölümünün okuyacağı gerçekler.
   *
   * TAM BURADA, çünkü yukarıdaki üç dalın hangisine girildiği ancak burada
   * belli oluyor: tarama kuruldu mu (`discoveryRun`), kurulmadıysa hangi
   * sebeple (`sweepReason`). Daha erken doldurmak, boot log'unun söylediğinden
   * BAŞKA bir şey gösteren bir panel demek olurdu.
   *
   * Her alan zaten hesaplanmış bir değerin taşınmasıdır; burada hiçbir karar
   * YENİDEN verilmiyor:
   *  · sürücü ve onu seçen değişken → `workDriverVariableName` (boot banner'ın
   *    kullandığı fonksiyonun aynısı),
   *  · tarama → `discoveryRun`/`sweepReason`/`discoverMs`/`discoverSource`,
   *  · statü taşıma → `statusMoverFor` (worker'ın kullandığı yapısal yoklama),
   *  · webhook → `JIRA_WEBHOOK_SECRET_REF`in DOLU olup olmadığı; referansın
   *    kendisi bile taşınmıyor, yalnız boş olup olmadığı.
   */
  deploymentConfig.current = {
    workDriver: deployment.selection.work.driver,
    workDriverVariable: workDriverVariableName(env.source),
    // Adresin sürücüye BENZEYİP benzemediği — kararı `jiraUrlMatchesDriver`
    // burada, URL'in gerçekten görüldüğü yerde veriyor ve dışarı yalnız bir
    // boolean çıkıyor. Adresin kendisi `@maestro/bff` paketine hiç girmez.
    cloudUrlLooksLikeCloud: jiraUrlMatchesDriver(env.source),
    sweepEnabled: discoveryRun !== undefined,
    sweepSeconds: discoveryRun === undefined ? 0 : Math.round(discoverMs / 1000),
    sweepSource: discoverConfigured ? "env" : "varsayilan",
    sweepOffReason:
      discoveryRun !== undefined
        ? null
        : sweepReason !== undefined
          ? "surucu-arama-sunmuyor"
          : "kapatildi",
    // Referansın DEĞERİ değil, yalnız yazılmış olup olmadığı. `driver-config.ts`
    // bu değişkeni sır deposundaki bir yola çeviriyor; sırrın kendisi hiçbir
    // zaman bu sürecin belleğinden panele geçmez.
    webhookSecretConfigured: (env.source["JIRA_WEBHOOK_SECRET_REF"] ?? "").trim() !== "",
    canMoveStatus: statusMoverFor(deployment.ports.work) !== undefined,
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
    // The supervision timer and any running poller, stopped BEFORE the socket
    // closes. A loop that outlives the process's other resources keeps handles
    // open — and worse, a round that starts during shutdown reaches a database
    // that is about to disconnect.
    commandIntake.current?.stop();
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
/**
 * Which flow this deployment runs by DEFAULT (`planFor`) — when no listening
 * rule claims the ticket. The per-ticket answer is `flow-decision.ts`.
 *
 * Read ONLY from `MAESTRO_FLOW`, and unset unless a site names one.
 *
 * It used to be derived from the profile: `analiz` meant every unclaimed ticket
 * became analysis-only, because that profile composed refusing scm/ci/scan
 * drivers and a run reaching engineering could not succeed. The derivation was
 * sound while the profile decided what the product could do — and it is exactly
 * what had to go when that stopped being true. The engineering ports compose on
 * every deployment now, so a profile no longer carries an opinion about what a
 * ticket is for, and inventing one here would put the old deployment-time
 * switch back under a different name.
 *
 * An unrecognised value is ignored rather than guessed — the full pipeline is
 * the safe direction, and it is the direction an operator can see: a run with
 * no repository connection fails naming the connection, which is fixable from
 * the panel, unlike a flow silently downgraded by a variable.
 */
function flowOf(env: DeployEnv): FlowType | null {
  const override = env.source["MAESTRO_FLOW"]?.trim();
  if (override !== undefined && override !== "") {
    const parsed = FlowType.safeParse(override);
    return parsed.success ? parsed.data : null;
  }
  return null;
}

/**
 * Alım kararı dökümünü yazan yer.
 *
 * Log satırı HER ZAMAN çıkar; `.md` yalnızca bir dizin verildiyse yazılır.
 * İkisinin ayrı olması bilinçli: satır, operatörün `docker compose logs` ile
 * ilk baktığı yer ve hiçbir kuruluma bağlı değil; dosya ise arşivlenebilir
 * ayrıntı ve bir cilt (volume) gerektirir.
 *
 * Yazma HATASI YUTULUR ve bir kez bildirilir: dolu bir disk ya da salt-okunur
 * bir bağlama, ticket alımını düşürecek bir sebep değil — `decisionLog`
 * sözleşmesinin fail-soft olma gerekçesinin aynısı. Sessiz de değil: sebep
 * bir kez log'a yazılır, her ticket'ta tekrarlanmaz.
 */
export function decisionLogSink(
  dir: string | undefined,
  log: (message: string) => void = (message) => {
    console.log(message);
  },
): (line: string, markdown: string) => void {
  const target = dir?.trim() ?? "";
  let warned = false;

  return (line, markdown) => {
    log(line);
    if (target === "") return;

    // Dosya adı ticket'tan türetiliyor ama ticket metni DEĞİL: yalnızca
    // güvenli karakterler geçiyor, çünkü bu bir dosya yolu ve ticket anahtarı
    // dışarıdan gelen bir değer.
    const safe = line.replace(/^\[karar\] /u, "").split(":")[0]?.replace(/[^A-Za-z0-9_-]/gu, "") ?? "ticket";
    const file = join(target, `${safe}-${String(Date.now())}.md`);
    void mkdir(target, { recursive: true })
      .then(() => writeFile(file, markdown, "utf8"))
      .catch((error: unknown) => {
        if (warned) return;
        warned = true;
        log(`[karar] döküm dosyası yazılamadı (${target}): ${String(error)} — log satırları sürüyor.`);
      });
  };
}

function notifyChannels(deployment: { selection: { notify: { driver: string; config: unknown } } }): readonly string[] {
  const { driver, config } = deployment.selection.notify;
  if (driver !== "multi") return [driver];
  return typeof config === "object" && config !== null ? Object.keys(config) : [];
}

/**
 * Clone the run's repository, or report that there is none.
 *
 * Best-effort on purpose. A repository the platform cannot reach — no token, a
 * private repo, a network that refuses — makes the analysis WORSE, because the
 * analyst then reasons from the ticket alone. It does not make the analysis
 * wrong, and `discoverRepo` already carries on when the session is unavailable.
 * Failing the run here would turn a degraded analysis into no analysis.
 *
 * The failure is logged rather than swallowed: an operator who expected the
 * analyst to read the repository needs to know it did not.
 */
/** Klon provasının okuduğu tek satırlık git çıktısı; okunamazsa `null`. */
const execFileAsync = promisify(execFile);
async function gitLine(path: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", path, ...args], { timeout: 15_000 });
    const line = stdout.trim();
    return line === "" ? null : line;
  } catch {
    return null;
  }
}

/**
 * `.git` DIŞINDAKİ dosya sayısı.
 *
 * Sayı, provanın "indi ama boş" halini ayıran tek işareti: yarım kalmış bir
 * klon da dizin bırakır, `.git` de taşır, ama içinde çalışılacak hiçbir şey
 * yoktur — sahada bu hal bir kez "indi" sanıldı.
 */
async function countFiles(path: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      "sh",
      ["-c", `find ${JSON.stringify(path)} -type f -not -path '*/.git/*' | wc -l`],
      { timeout: 60_000 },
    );
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function checkoutOrNull(
  env: DeployEnv,
  secrets: SecretPort,
  run: { runId: string; appId: string | null; targetBranch?: string | null },
): Promise<{ path: string; branch: string | null } | null> {
  // An analysis-only run has no repository to check out — that is the
  // binding's deliberate shape, not a clone failure, so there is nothing to
  // warn about either. The skip is journaled by the workflow itself at 3ö.
  if (run.appId === null) return null;
  const root = env.source["WORKSPACE_ROOT"]?.trim();
  /**
   * KAPALI KEŞİF SESSİZ KALMAZ — ARTIK.
   *
   * Bu dal bir dönem çıplak `return null`'dı. Kurulumda `WORKSPACE_ROOT`
   * tanımlanmamışsa (compose onu `${WORKSPACE_ROOT:-}` ile boş dize olarak
   * geçirir, yani "yok" ile "boş" aynı görünür) hiçbir koşu klon açmıyor,
   * analiz depoyu HİÇ görmeden yazılıyor ve bunu söyleyen tek bir satır
   * yoktu. Sahada aylarca böyle çalıştı: ölçüldü, klon klasörlerinin en
   * yenisi kurulumdan haftalar öncesine aitti ve operatörün gördüğü tek şey
   * "analiz kodla ilgisiz" oldu.
   *
   * Eksik yapılandırma bir HATA değil (keşifsiz kurulum geçerli bir seçim),
   * ama SESSİZ olmamalı: koşu başına bir kez, koşunun kimliğiyle yazılır.
   */
  if (root === undefined || root === "") {
    console.warn(
      `[maestro] ${run.runId}: WORKSPACE_ROOT tanımlı DEĞİL — ${run.appId} klonlanmayacak ve analiz ` +
        `depoyu görmeden yapılacak. Açmak için .env'e WORKSPACE_ROOT="/workspace" (özel depo için ayrıca ` +
        `SCM_TOKEN_REF) yazıp servisleri yeniden başlatın.`,
    );
    return null;
  }

  const tokenRef = env.source["SCM_TOKEN_REF"]?.trim();
  try {
    const token = tokenRef === undefined || tokenRef === "" ? undefined : await secrets.get(tokenRef);
    const scmHost = env.source["SCM_HOST"]?.trim() ?? "";
    const branch = run.targetBranch?.trim() ?? "";
    const path = await prepareWorkspace({
      repo: run.appId,
      root,
      runId: run.runId,
      ...(branch === "" ? {} : { branch }),
      /**
       * Blank is ABSENT, not a host.
       *
       * `?.trim()` is `undefined` only when the KEY is missing, and both
       * bundles ship `SCM_HOST: ${SCM_HOST:-}` — present and empty. So an
       * install that never set it passed `host: ""`, which defeats the
       * `?? "github.com"` fallback in `prepareWorkspace` and turns every
       * enrichment clone into `https:///owner/repo.git`. The two settings
       * above already use this pair; this one had drifted.
       */
      ...(scmHost === "" ? {} : { host: scmHost }),
      ...(token === undefined ? {} : { token }),
    });
    return { path, branch: await checkedOutBranch(path) };
  } catch (error) {
    console.warn(
      `[maestro] ${run.runId}: depo çekilemedi, analiz depoyu görmeden yapılacak — ${String(error)}`,
    );
    return null;
  }
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name}: required — the BFF cannot serve without it (M6)`);
  return value;
}

/**
 * Bir koşu satırının tanı raporuna giren kadarı.
 *
 * `updatedAt` saniyeye yuvarlanıp boşlukla ayrılıyor: rapor bir insanın
 * okuyacağı bir sayfa, ve ISO'nun `T`si ile milisaniyeleri o sayfada gürültü.
 * `bin/tani.ts`teki `bicimle` ile aynı biçim — iki rapor arasında aynı koşuyu
 * gözle eşleştirebilmek için.
 */
function kosuSatiri(row: {
  id: string;
  ticketKey: string;
  step: string;
  status: string;
  updatedAt: Date;
}): KosuSatiri {
  return {
    id: row.id,
    ticketKey: row.ticketKey,
    step: row.step,
    status: row.status,
    updatedAt: row.updatedAt.toISOString().replace("T", " ").slice(0, 19),
  };
}

if (isEntrypoint(import.meta.url)) {
  await main().catch(fail);
}
