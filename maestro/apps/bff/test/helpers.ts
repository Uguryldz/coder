import { AuditChain, InMemoryAuditStore } from "@maestro/audit";
import { t } from "@maestro/config";
import type { CiResultSignal, Locale, ParamDefinition } from "@maestro/contracts";
import type { FastifyInstance } from "fastify";
import { InMemoryUserDirectory, LocalIdentityProvider } from "../src/auth/local-identity.js";
import { InMemorySessionStore } from "../src/auth/sessions.js";
import type { BffDeps, Clock, JiraBinding, MessageCatalog } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import {
  InMemoryKillSwitchStore,
  InMemoryParamStore,
  StaticGateDirectory,
  StaticJiraProjectBindings,
} from "../src/stores/memory.js";
import { FakeCiPort, FakeRunGateway, FakeWorkEventReader, FakeWorkPort, WEBHOOK_SECRET } from "./fakes.js";

/**
 * Catalog keys `packages/config` does not carry yet; the tr+en wording is in
 * RAPOR.md for the orchestrator to add. Once they land, this table empties and
 * `messages.test.ts` says so.
 */
export const PENDING_CATALOG_TEXT: Record<string, string> = {
  "command.accepted": "{command} komutu alındı.",
  "command.no_run": "{ticket} için çalışan bir Maestro akışı yok.",
  "command.no_open_gate": "{ticket} şu anda açık bir onay kapısında değil.",
  "command.run_status": "{ticket} · adım: {step} · durum: {status}",
  "command.unsupported": "{command} komutu bu sürümde desteklenmiyor.",
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
  killSwitch: InMemoryKillSwitchStore;
  bindings: StaticJiraProjectBindings;
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

export interface HarnessOptions {
  groups?: Record<string, readonly string[]>;
  bindings?: readonly JiraBinding[];
  ciSignal?: CiResultSignal | null;
  adoAuthorization?: string;
  deps?: Partial<BffDeps>;
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
  const killSwitch = new InMemoryKillSwitchStore();
  const bindings = new StaticJiraProjectBindings(options.bindings ?? [UGURPAY_BINDING]);

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
    killSwitch,
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
    killSwitch,
    bindings,
    login,
    addUser,
    delegatedToken,
  };
}

export function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
