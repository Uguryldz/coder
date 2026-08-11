import type { Server } from "node:http";
import type { FetchLike as JiraFetchLike } from "@maestro/adapter-jira";
import type { FetchLike as GithubFetchLike } from "@maestro/adapter-github";
import type { TicketKey } from "@maestro/contracts";
import {
  ADO_ORG,
  ADO_PORT,
  ADO_PR_VALIDATION_DEFINITION,
  ADO_PROJECT,
  ADO_REPO,
  ADO_WEBHOOK_USERNAME,
  defaultSettings,
  PILOT_SECRETS,
  scmMode,
  UI_PORT,
  type ScmMode,
} from "./config.js";
import { SettingsStore } from "./settings.js";
import {
  loadRepoEnv,
  resolveGithub,
  resolveJiraCloud,
  resolveOpenRouter,
  type GithubEnv,
  type JiraCloudEnv,
  type OpenRouterEnv,
} from "./env.js";
import type { CreateWorkspaceOptions } from "./workspace.js";
import { DocStore } from "./docs.js";
import { createFakeAdo, type FakeAdo } from "./fake-ado.js";
import { close, listen } from "./http.js";
import { discoverTickets } from "./poll.js";
import { PilotRun } from "./run.js";
import { createUiServer } from "./server.js";
import { initialState, StateStore } from "./state.js";
import {
  createPilotAudit,
  createPilotCiPort,
  createPilotFakeScmPort,
  createPilotGateway,
  createPilotScmPort,
  createPilotSecrets,
  createPilotWorkPort,
} from "./wiring.js";

/**
 * Boots the pilot: the FAKE ADO prop, and Maestro (UI + ADO webhook endpoint)
 * wired to the real package drivers — with the Jira WorkPort pointed at the
 * LIVE site. Ports default to the pilot's fixed ones; tests pass 0 for
 * ephemeral ports and inject `jiraFetch` + `llmFetch` so nothing touches the
 * network.
 */

export interface BootOptions {
  uiPort?: number;
  adoPort?: number;
  /**
   * Injectable environment. When provided it is the SOLE source for every
   * env-derived boot decision (SCM mode, OpenRouter, Jira, GitHub) — the real
   * `maestro/.env` (`loadRepoEnv()`) is NOT read and `process.env` is IGNORED.
   * Tests pass `env: {}` (or a fixed map) so a polluted developer shell (e.g.
   * `PILOT_SCM=github`, a real `GITHUB_TOKEN`) can never sweep an offline test
   * into real network behaviour. When unset (the real app) `loadRepoEnv()` is
   * read and `process.env` still layers over it, exactly as before.
   */
  env?: Record<string, string>;
  /** Overrides env resolution; tests pass dummies alongside the injected fetches. */
  openRouter?: OpenRouterEnv;
  jiraCloud?: JiraCloudEnv;
  /** Which ScmPort to drive. Defaults to PILOT_SCM (env), which defaults to `fake`. */
  scm?: ScmMode;
  /** Overrides GitHub env resolution; tests pass a dummy alongside `githubFetch`. */
  github?: GithubEnv;
  /** Injected GitHub REST/GraphQL transport (stub) — keeps the github path offline in tests. */
  githubFetch?: GithubFetchLike;
  /** Injected exec runner for the git push — tests stub it so nothing shells out. */
  workspaceOptions?: CreateWorkspaceOptions;
  /** Injected LLM transport so tests never touch the network. */
  llmFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Injected Jira Cloud transport (recorded fixtures) — keeps the pilot offline in tests. */
  jiraFetch?: JiraFetchLike;
  /** Delay before the fake build result arrives. */
  buildDelayMs?: number;
  ciTimeoutMs?: number;
  /** Gate comment poll interval (ms) — tests pass a small value. */
  commandPollMs?: number;
  /** Sleep injected into the gate poller so tests don't wait on real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Off by default in tests; the running app turns the discovery loop on. */
  startDiscovery?: boolean;
}

export interface PilotStage {
  uiUrl: string;
  adoUrl: string;
  jiraSite: string;
  store: StateStore;
  settings: SettingsStore;
  run: PilotRun;
  ado: FakeAdo;
  /** One discovery pass on demand (also used by the running app's loop). */
  refreshDiscovery(): Promise<void>;
  start(ticketKey: TicketKey): Promise<void>;
  close(): Promise<void>;
}

export async function bootPilot(options: BootOptions = {}): Promise<PilotStage> {
  // When `options.env` is injected it is AUTHORITATIVE: the real `maestro/.env`
  // is not read and `process.env` is ignored, so no boot decision can leak from
  // the developer's shell or repo file. Tests inject `{}` (or a fixed map) to
  // stay hermetic; the real app injects nothing and reads `maestro/.env`.
  const injected = options.env !== undefined;
  const repoEnv = options.env ?? loadRepoEnv();
  const openRouter = options.openRouter ?? resolveOpenRouter(repoEnv, injected);
  const jiraCloud = options.jiraCloud ?? resolveJiraCloud(repoEnv, injected);

  // SCM edge (Dalga C2). `fake` (the default) is unchanged. `github` resolves
  // the real GitHub edge — owner/repo/token — and builds the real ScmPort.
  const mode: ScmMode = options.scm ?? scmMode(repoEnv, injected);
  const github: GithubEnv | undefined =
    mode === "github" ? (options.github ?? resolveGithub(repoEnv, injected)) : undefined;

  let uiBase: string | null = null;
  const errors: unknown[] = [];

  const ado = createFakeAdo({
    org: ADO_ORG,
    project: ADO_PROJECT,
    repo: ADO_REPO,
    pat: PILOT_SECRETS.adoPat,
    webhookUsername: ADO_WEBHOOK_USERNAME,
    webhookSecret: PILOT_SECRETS.adoWebhook,
    webhookUrl: () => (uiBase === null ? null : `${uiBase}/webhooks/ado`),
    definitionId: ADO_PR_VALIDATION_DEFINITION,
    ...(options.buildDelayMs === undefined ? {} : { buildDelayMs: options.buildDelayMs }),
    onError: (error) => errors.push(error),
  });

  const adoPort = await listen(ado.server, options.adoPort ?? ADO_PORT);
  const adoUrl = `http://127.0.0.1:${adoPort}`;

  // Runtime settings live here, seeded from env (M71): the UI edits these at
  // runtime, and every use site reads from the store — not from a module-load
  // constant — so a change takes effect on the next run/poll without a restart.
  const settings = new SettingsStore(defaultSettings());
  const seeded = settings.snapshot();

  const store = new StateStore(
    initialState({ model: seeded.model, jiraSite: jiraCloud.baseUrl, approverGroup: seeded.approverGroup }),
  );

  const secrets = createPilotSecrets(openRouter, jiraCloud, github);
  const { gateway, policy } = createPilotGateway(secrets, openRouter, {
    runId: () => store.snapshot().runId,
    onCallLog: (log) => {
      store.update((state) => {
        state.llmCalls += 1;
        state.tokens += log.tokensIn + log.tokensOut;
      });
      store.log("dim", `→ model ${log.driver}/${log.model} · rol ${log.role} · ${log.tokensIn}+${log.tokensOut} token`);
    },
    onMasked: (event) => {
      if (event.counts.fields === 0) return;
      store.update((state) => {
        state.maskedFields += event.counts.fields;
      });
      store.log(
        "info",
        `→ PII maskelendi (${event.leg === "request" ? "gidiş" : "dönüş"}): ${event.counts.fields} alan · ${event.counts.occurrences} eşleşme`,
      );
    },
    ...(options.llmFetch ? { fetchImpl: options.llmFetch } : {}),
  });

  const work = createPilotWorkPort(secrets, jiraCloud, options.jiraFetch);
  const docs = new DocStore();

  // On the github path the real driver does branch/PR/push; the CI signal and
  // merge stay faked (C3 integrates real GitHub checks). `mergeStatus` points at
  // a fake ADO scm driver, and `onRealPrOpened` registers the real PR id on the
  // fake so its status can be reported and drives the fake CI publisher.
  const scmPort = createPilotScmPort(secrets, adoUrl, github, options.githubFetch);
  const githubRunConfig =
    github === undefined
      ? undefined
      : { remoteUrl: `${github.gitBaseUrl}/${github.owner}/${github.repo}.git`, owner: github.owner, repo: github.repo };

  const run = new PilotRun({
    work,
    scm: scmPort,
    ci: createPilotCiPort(secrets, adoUrl),
    scmMode: mode,
    llm: gateway,
    audit: createPilotAudit(),
    piiPolicy: policy,
    store,
    settings,
    docs,
    completePullRequest: (prId) => ado.completePullRequest(prId),
    ...(githubRunConfig ? { github: githubRunConfig } : {}),
    ...(options.workspaceOptions ? { workspaceOptions: options.workspaceOptions } : {}),
    ...(github
      ? {
          mergeStatus: createPilotFakeScmPort(secrets, adoUrl),
          onRealPrOpened: (prId, sourceRef) => {
            ado.registerExternalPr(prId, sourceRef);
            ado.emitBuildCompleteFor(prId, sourceRef);
          },
        }
      : {}),
    ...(options.ciTimeoutMs === undefined ? {} : { ciTimeoutMs: options.ciTimeoutMs }),
    ...(options.commandPollMs === undefined ? {} : { commandPollMs: options.commandPollMs }),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  const refreshDiscovery = async (): Promise<void> => {
    try {
      const rows = await discoverTickets(work);
      store.update((state) => {
        state.discovered = rows;
      });
    } catch (error) {
      store.log("warn", `! keşif yoklaması başarısız: ${String(error)}`);
    }
  };

  const ui: Server = createUiServer({ store, settings, run, docs, start: (ticketKey) => run.start(ticketKey) });
  const uiPort = await listen(ui, options.uiPort ?? UI_PORT);
  uiBase = `http://127.0.0.1:${uiPort}`;

  // Discovery loop: only the running app turns it on; tests call refreshDiscovery
  // explicitly so no timer fires and no live request leaves the process. The
  // interval is re-read from the SettingsStore each cycle (self-rescheduling
  // setTimeout, not a fixed setInterval) so a UI change to the discovery poll
  // takes effect on the next cycle without a restart.
  let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let discoveryStopped = false;
  const scheduleDiscovery = (): void => {
    if (discoveryStopped) return;
    discoveryTimer = setTimeout(() => {
      void refreshDiscovery().finally(scheduleDiscovery);
    }, settings.snapshot().discoveryPollMs);
  };
  if (options.startDiscovery === true) {
    await refreshDiscovery();
    scheduleDiscovery();
  }

  return {
    uiUrl: uiBase,
    adoUrl,
    jiraSite: jiraCloud.baseUrl,
    store,
    settings,
    run,
    ado,
    refreshDiscovery,
    start: (ticketKey) => run.start(ticketKey),
    async close(): Promise<void> {
      discoveryStopped = true;
      if (discoveryTimer !== null) clearTimeout(discoveryTimer);
      await Promise.all([close(ui), close(ado.server)]);
    },
  };
}
