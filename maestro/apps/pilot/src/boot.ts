import type { Server } from "node:http";
import type { FetchLike } from "@maestro/adapter-jira";
import type { TicketKey } from "@maestro/contracts";
import {
  ADO_ORG,
  ADO_PORT,
  ADO_PR_VALIDATION_DEFINITION,
  ADO_PROJECT,
  ADO_REPO,
  ADO_WEBHOOK_USERNAME,
  APPROVER_GROUP,
  DISCOVERY_POLL_MS,
  PILOT_MODEL,
  PILOT_SECRETS,
  UI_PORT,
} from "./config.js";
import {
  loadRepoEnv,
  resolveJiraCloud,
  resolveOpenRouter,
  type JiraCloudEnv,
  type OpenRouterEnv,
} from "./env.js";
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
  /** Overrides env resolution; tests pass dummies alongside the injected fetches. */
  openRouter?: OpenRouterEnv;
  jiraCloud?: JiraCloudEnv;
  /** Injected LLM transport so tests never touch the network. */
  llmFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Injected Jira Cloud transport (recorded fixtures) — keeps the pilot offline in tests. */
  jiraFetch?: FetchLike;
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
  run: PilotRun;
  ado: FakeAdo;
  /** One discovery pass on demand (also used by the running app's loop). */
  refreshDiscovery(): Promise<void>;
  start(ticketKey: TicketKey): Promise<void>;
  close(): Promise<void>;
}

export async function bootPilot(options: BootOptions = {}): Promise<PilotStage> {
  const repoEnv = loadRepoEnv();
  const openRouter = options.openRouter ?? resolveOpenRouter(repoEnv);
  const jiraCloud = options.jiraCloud ?? resolveJiraCloud(repoEnv);

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

  const store = new StateStore(
    initialState({ model: PILOT_MODEL, jiraSite: jiraCloud.baseUrl, approverGroup: APPROVER_GROUP }),
  );

  const secrets = createPilotSecrets(openRouter, jiraCloud);
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

  const run = new PilotRun({
    work,
    scm: createPilotScmPort(secrets, adoUrl),
    ci: createPilotCiPort(secrets, adoUrl),
    llm: gateway,
    audit: createPilotAudit(),
    piiPolicy: policy,
    store,
    docs,
    completePullRequest: (prId) => ado.completePullRequest(prId),
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

  const ui: Server = createUiServer({ store, run, docs, start: (ticketKey) => run.start(ticketKey) });
  const uiPort = await listen(ui, options.uiPort ?? UI_PORT);
  uiBase = `http://127.0.0.1:${uiPort}`;

  // Discovery loop: only the running app turns it on; tests call refreshDiscovery
  // explicitly so no timer fires and no live request leaves the process.
  let discoveryTimer: ReturnType<typeof setInterval> | null = null;
  if (options.startDiscovery === true) {
    await refreshDiscovery();
    discoveryTimer = setInterval(() => void refreshDiscovery(), DISCOVERY_POLL_MS);
  }

  return {
    uiUrl: uiBase,
    adoUrl,
    jiraSite: jiraCloud.baseUrl,
    store,
    run,
    ado,
    refreshDiscovery,
    start: (ticketKey) => run.start(ticketKey),
    async close(): Promise<void> {
      if (discoveryTimer !== null) clearInterval(discoveryTimer);
      await Promise.all([close(ui), close(ado.server)]);
    },
  };
}
