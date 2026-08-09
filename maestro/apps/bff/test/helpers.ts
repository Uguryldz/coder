import { AuditChain, InMemoryAuditStore } from "@maestro/audit";
import { t } from "@maestro/config";
import type { CiResultSignal, Locale, ParamDefinition } from "@maestro/contracts";
import type { FastifyInstance } from "fastify";
import { InMemoryUserDirectory, LocalIdentityProvider } from "../src/auth/local-identity.js";
import { InMemorySessionStore } from "../src/auth/sessions.js";
import type {
  BffDeps,
  Clock,
  JiraBinding,
  MessageCatalog,
  ReadModels,
  TemplateVersionRecord,
} from "../src/deps.js";
import { buildServer } from "../src/server.js";
import {
  InMemoryKillSwitchStore,
  InMemoryParamStore,
  InMemoryTemplateStore,
  StaticGateDirectory,
  StaticJiraProjectBindings,
} from "../src/stores/memory.js";
import {
  AuditStoreReader,
  InMemoryAppRegistry,
  InMemoryCostReader,
  InMemoryEvidenceReader,
  InMemoryGateBoard,
  InMemoryJournalReader,
  InMemoryKnowledgeIndex,
  InMemoryQuotaReader,
  InMemoryRunCatalog,
  InMemoryRunnerFleet,
  InMemoryScanReader,
  StaticHealthReader,
} from "../src/stores/read-memory.js";
import type { ServiceHealth } from "../src/read-models.js";
import { FakeCiPort, FakeRunGateway, FakeWorkEventReader, FakeWorkPort, WEBHOOK_SECRET } from "./fakes.js";

/**
 * Catalog keys `packages/config` does not carry yet; the tr+en wording is in
 * RAPOR.md for the orchestrator to add. Once they land, this table empties and
 * `messages.test.ts` says so.
 *
 * The original five have since shipped. `command.unknown_actor` is the one this
 * hardening packet added: it is written to a ticket whose comment author cannot
 * be attributed to a corporate account (M33).
 */
export const PENDING_CATALOG_TEXT: Record<string, string> = {
  "command.unknown_actor":
    "{command} komutu işlenemedi: yorumu yazan hesap kurumsal bir kullanıcıya eşlenemedi.",
};

/** The shipped catalog, plus the keys still awaiting an orchestrator edit. */
export const testCatalog: MessageCatalog = {
  t(locale: Locale, key: string, params: Record<string, string> = {}): string {
    const pending = PENDING_CATALOG_TEXT[key];
    if (pending === undefined) return t(locale, key, params);
    return pending.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole);
  },
};

export class TestClock implements Clock {
  constructor(private current = new Date("2026-08-09T09:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export const UGURPAY_BINDING: JiraBinding = {
  projectKey: "UGURPAY",
  active: true,
  triggerMode: "auto",
  appId: "ugurpay",
  mode: "full_auto",
  dataClass: "dahili",
};

export const PARAM_DEFINITIONS: ParamDefinition[] = [
  {
    key: "gate.set",
    scope: "global",
    type: "json",
    guarded: true,
    descriptionKey: "params.description.gate_set",
    defaultValue: {},
  },
  {
    key: "reminder.channel",
    scope: "global",
    type: "enum",
    guarded: false,
    enumValues: ["teams", "smtp", "slack"],
    descriptionKey: "params.description.reminder_channel",
    defaultValue: "teams",
  },
];

export interface Harness {
  app: FastifyInstance;
  work: FakeWorkPort;
  ci: FakeCiPort;
  runs: FakeRunGateway;
  chain: AuditChain;
  auditStore: InMemoryAuditStore;
  clock: TestClock;
  sessions: InMemorySessionStore;
  users: InMemoryUserDirectory;
  identity: LocalIdentityProvider;
  params: InMemoryParamStore;
  templates: InMemoryTemplateStore;
  killSwitch: InMemoryKillSwitchStore;
  bindings: StaticJiraProjectBindings;
  /** Studio's read side, as concrete stores the tests seed directly. */
  read: TestReadModels;
  /** `MaestroPlatform` over this harness — what maestro-mcp would be injected with. */
  platform: FastifyInstance["platform"];
  /** Log in and return the bearer token. */
  login(username: string, password?: string): Promise<string>;
  /** Create an account and return its username. */
  addUser(user: {
    username: string;
    userId?: string;
    password?: string;
    roles?: string[];
    groups?: string[];
  }): Promise<string>;
  /** Mint a session directly — the only way to get a delegated (`ai-via:`) one. */
  delegatedToken(username: string): Promise<string>;
}

export const TEST_PASSWORD = "Maestro!Test-2026";

/**
 * The read side as concrete stores rather than interfaces, so a test can seed
 * exactly the rows the endpoint under test should return — and so an endpoint
 * that invents a field instead of reading one fails here.
 */
export interface TestReadModels extends ReadModels {
  runs: InMemoryRunCatalog;
  journal: InMemoryJournalReader;
  gates: InMemoryGateBoard;
  apps: InMemoryAppRegistry;
  knowledge: InMemoryKnowledgeIndex;
  runners: InMemoryRunnerFleet;
  cost: InMemoryCostReader;
  scans: InMemoryScanReader;
  evidence: InMemoryEvidenceReader;
}

/**
 * A published version 1, so the read endpoint has something to return and a
 * save under test becomes version 2 — the interesting case, since publishing
 * must never overwrite what a pinned run is still reading (M83).
 */
export const SEED_TEMPLATE: TemplateVersionRecord = {
  name: "Analiz şablonu",
  version: 1,
  sections: [
    {
      key: "amac",
      title: "Amaç",
      description: "",
      aiInstruction: "Ticket'ın çözdüğü iş problemini yaz.",
      required: true,
      format: "free_text",
      example: "",
    },
  ],
  publishedBy: "ayse.kaya@ugurbank.local",
  publishedAt: "2026-08-01T09:00:00.000Z",
};

export const TEST_SERVICES: readonly ServiceHealth[] = [
  {
    service: "bff",
    state: "healthy",
    version: "0.1.0",
    checkedAt: "2026-08-09T09:00:00.000Z",
    note: null,
  },
];

export interface HarnessOptions {
  groups?: Record<string, readonly string[]>;
  bindings?: readonly JiraBinding[];
  ciSignal?: CiResultSignal | null;
  adoAuthorization?: string;
  deps?: Partial<BffDeps>;
  /** Subscription pool (M55); empty by default — most tests do not exercise quota. */
  accounts?: ReadModels["quota"];
  services?: readonly ServiceHealth[];
  /** Published template versions; defaults to a single seeded version 1. */
  templates?: readonly TemplateVersionRecord[];
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const work = new FakeWorkPort(WEBHOOK_SECRET, options.groups ?? {});
  const ci = new FakeCiPort(options.adoAuthorization ?? "Basic dGVzdDpzZWNyZXQ=", options.ciSignal ?? null);
  const runs = new FakeRunGateway();
  const auditStore = new InMemoryAuditStore();
  const clock = new TestClock();
  const chain = new AuditChain({ store: auditStore, clock });
  const sessions = new InMemorySessionStore();
  const users = new InMemoryUserDirectory();
  // Cost 4: the tests exercise bcrypt for real, but a production cost would
  // add minutes to the suite for no extra coverage.
  const { BcryptPasswordHasher } = await import("../src/auth/password.js");
  const identity = new LocalIdentityProvider(users, new BcryptPasswordHasher(4));
  const params = new InMemoryParamStore(PARAM_DEFINITIONS);
  const templates = new InMemoryTemplateStore(options.templates ?? [SEED_TEMPLATE], [
    { projectKey: "UGURPAY", version: 1, pinnedRuns: 0 },
  ]);
  const killSwitch = new InMemoryKillSwitchStore();
  const bindings = new StaticJiraProjectBindings(options.bindings ?? [UGURPAY_BINDING]);

  const read: TestReadModels = {
    runs: new InMemoryRunCatalog(),
    journal: new InMemoryJournalReader(),
    gates: new InMemoryGateBoard(),
    apps: new InMemoryAppRegistry(),
    knowledge: new InMemoryKnowledgeIndex(),
    runners: new InMemoryRunnerFleet(),
    quota: options.accounts ?? new InMemoryQuotaReader(),
    cost: new InMemoryCostReader(),
    scans: new InMemoryScanReader(),
    evidence: new InMemoryEvidenceReader(),
    // The SAME store the chain appends to: a reader with its own copy would
    // verify itself rather than the trail.
    audit: new AuditStoreReader(auditStore),
    health: new StaticHealthReader(options.services ?? TEST_SERVICES),
  };

  const app = await buildServer({
    work,
    workEvents: new FakeWorkEventReader(),
    ci,
    runs,
    audit: chain,
    sessions,
    identity,
    users,
    bindings,
    gates: new StaticGateDirectory(),
    params,
    templates,
    killSwitch,
    read,
    messages: testCatalog,
    clock,
    config: { actorDomain: "ugurbank.local" },
    ...options.deps,
  });

  const addUser: Harness["addUser"] = async (user) => {
    await identity.provision({
      username: user.username,
      userId: user.userId ?? `${user.username}@ugurbank.local`,
      password: user.password ?? TEST_PASSWORD,
      groups: user.groups ?? [],
      roles: user.roles ?? [],
    });
    return user.username;
  };

  const login: Harness["login"] = async (username, password = TEST_PASSWORD) => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username, password },
    });
    if (response.statusCode !== 200) throw new Error(`login failed: ${response.body}`);
    return (response.json() as { token: string }).token;
  };

  const delegatedToken: Harness["delegatedToken"] = async (username) => {
    const record = await users.find(username);
    if (record === null) throw new Error(`no such user: ${username}`);
    const { issueSession } = await import("../src/auth/sessions.js");
    const session = issueSession(
      { userId: record.userId, username: record.username, groups: record.groups, roles: record.roles },
      { clock, delegated: true },
    );
    await sessions.create(session);
    return session.token;
  };

  return {
    app,
    work,
    ci,
    runs,
    chain,
    auditStore,
    clock,
    sessions,
    users,
    identity,
    params,
    templates,
    killSwitch,
    bindings,
    read,
    platform: app.platform,
    login,
    addUser,
    delegatedToken,
  };
}

export function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
