import type {
  MatchResult,
  Notification,
  PublishReceipt,
  RoutingRule,
  ScanResult,
  TicketSnapshot,
} from "@maestro/contracts";
import { AuditChain, InMemoryAuditStore } from "@maestro/audit";
import type { AgentTurnRequest, AgentTurnResult } from "@maestro/execution";
import { createJournalMasker } from "@maestro/memory";
import { defaultPiiPolicy } from "@maestro/pii";
import type { LlmOutcome, RepoRef } from "@maestro/ports";
import type { ActivityDeps, RunContext } from "../src/impl/deps.js";
import { InMemoryIdempotency } from "../src/impl/idempotency.js";
import {
  APP,
  LADDER,
  MemoryGateStore,
  MemoryJournalStore,
  ROUTING,
  SNAPSHOT,
  runContext,
} from "./doubles.js";

/**
 * Offline doubles for everything an activity touches.
 *
 * They are as strict as the real thing where strictness is the point — the
 * audit chain is the REAL `AuditChain` over an in-memory store, and journal
 * text goes through the REAL masker — and are dumb recorders everywhere else.
 * Anything a test did not wire throws instead of returning a plausible-looking
 * default: a fake that quietly answers is how a test stops testing.
 */

export * from "./doubles.js";

/** Everything a test wants to look at afterwards, in one place. */
export interface Recorded {
  comments: Array<{ ticket: string; body: unknown }>;
  /** Who the ticket was handed to — the `analiz` flow's delivery. */
  assignments: Array<{ ticket: string; to: string | null }>;
  labels: string[][];
  notifications: Notification[];
  published: Array<{ doc: string; markdown: string }>;
  stored: Array<{ key: string; bytes: number }>;
  children: Array<{ summary: string; description: string }>;
  turns: AgentTurnRequest[];
  scans: string[];
  llm: Array<{ role: string; schemaName: string }>;
}

export interface Fakes {
  deps: ActivityDeps;
  recorded: Recorded;
  journalStore: MemoryJournalStore;
  gateStore: MemoryGateStore;
  chain: AuditChain;
  patches: Array<Partial<RunContext>>;
}

export interface FakeOptions {
  context?: Partial<RunContext>;
  generateObject?: (schemaName: string) => LlmOutcome<unknown>;
  agentSession?: () => LlmOutcome<{ resumeToken: string; finalText: string; log: never }>;
  runTurn?: (req: AgentTurnRequest) => AgentTurnResult;
  scan?: (tool: string) => ScanResult | Promise<ScanResult>;
  rules?: RoutingRule[];
  match?: MatchResult | null;
  ticket?: TicketSnapshot;
  members?: (group: string) => string[];
  /** Makes `assign` reject, for the fail-soft delivery path. */
  assignFails?: boolean;
  /** Role -> directory group, when a test needs the two to differ. */
  groupForRole?: (role: string) => string;
  prState?: { state: "draft" | "active" | "completed" | "abandoned"; mergeSha: string | null };
  verifyMembership?: boolean;
}

const NOT_WIRED = (name: string) => (): never => {
  throw new Error(`fake: ${name} is not wired for this test`);
};

function emptyRecord(): Recorded {
  return {
    comments: [],
    assignments: [],
    labels: [],
    notifications: [],
    published: [],
    stored: [],
    children: [],
    turns: [],
    scans: [],
    llm: [],
  };
}

export function makeFakes(options: FakeOptions = {}): Fakes {
  const recorded = emptyRecord();
  const journalStore = new MemoryJournalStore();
  const gateStore = new MemoryGateStore();
  const chain = new AuditChain({ store: new InMemoryAuditStore() });
  let context = runContext(options.context);
  const patches: Array<Partial<RunContext>> = [];
  const repo: RepoRef = { project: APP.adoProject, repo: APP.adoRepo };

  const deps: ActivityDeps = {
    runs: {
      get: () => Promise.resolve(context),
      patch: (_ticket, changes) => {
        patches.push(changes);
        context = { ...context, ...changes };
        return Promise.resolve();
      },
    },
    gates: gateStore,
    params: {
      escalationLadder: () => Promise.resolve(LADDER),
      notifyRouting: () => Promise.resolve(ROUTING),
      routingRules: () => Promise.resolve(options.rules ?? []),
      publishTargets: () => Promise.resolve(["jira"]),
    },
    directory: {
      membersOf: (group) => Promise.resolve(options.members?.(group) ?? [`${group}@bank`]),
      // Default: the role IS the group, which is the configuration-free case.
      // `options.groupForRole` lets a test give the two different names, the
      // way a real Jira site does.
      groupForRole: (role) => Promise.resolve(options.groupForRole?.(role) ?? role),
    },
    work: {
      verifyWebhook: NOT_WIRED("verifyWebhook"),
      getTicket: () => Promise.resolve(options.ticket ?? SNAPSHOT),
      addComment: (key, body) => {
        recorded.comments.push({ ticket: key, body });
        return Promise.resolve({ commentId: `c${recorded.comments.length}` });
      },
      updateComment: () => Promise.resolve(),
      setLabels: (_key, labels) => {
        recorded.labels.push(labels);
        return Promise.resolve();
      },
      assign: (ticket, to) => {
        if (options.assignFails === true) return Promise.reject(new Error("jira: assign 403"));
        recorded.assignments.push({ ticket, to });
        return Promise.resolve();
      },
      createLinkedIssue: (_parent, fields) => {
        recorded.children.push({ summary: fields.summary, description: fields.description });
        return Promise.resolve({ key: `PAY-${200 + recorded.children.length}` });
      },
      parseCommand: () => Promise.resolve(null),
      verifyMembership: () => Promise.resolve(options.verifyMembership ?? true),
      transition: NOT_WIRED("transition"),
    },
    scm: {
      resolveRepo: () => Promise.resolve(repo),
      createBranch: () => Promise.resolve(),
      getPushCredential: NOT_WIRED("getPushCredential"),
      openPr: () => Promise.resolve({ prId: 77 }),
      activatePr: () => Promise.resolve(),
      listPrThreads: () => Promise.resolve([]),
      replyThread: () => Promise.resolve(),
      getPrStatus: () =>
        Promise.resolve({
          prId: 77,
          state: options.prState?.state ?? "completed",
          mergeSha: options.prState === undefined ? "abcdef1" : options.prState.mergeSha,
        }),
    },
    llm: {
      generateObject: (req, schema) => {
        recorded.llm.push({ role: req.role, schemaName: req.schemaName });
        const outcome = options.generateObject?.(req.schemaName);
        if (outcome === undefined) throw new Error(`fake llm: no answer for ${req.schemaName}`);
        if (outcome.status !== "ok") return Promise.resolve(outcome);
        return Promise.resolve({ ...outcome, value: schema.parse(outcome.value) });
      },
      agentSession: () => {
        const outcome = options.agentSession?.();
        if (outcome === undefined) throw new Error("fake llm: no agent session answer");
        return Promise.resolve(outcome);
      },
    },
    scan: {
      run: async (tool) => {
        recorded.scans.push(tool);
        if (options.scan === undefined) throw new Error("fake scan: not wired");
        return options.scan(tool);
      },
    },
    storage: {
      put: (key, data) => {
        recorded.stored.push({ key, bytes: data.byteLength });
        return Promise.resolve();
      },
      get: NOT_WIRED("storage.get"),
      list: () => Promise.resolve(recorded.stored.map((s) => s.key)),
      delete: () => Promise.resolve(),
      presign: NOT_WIRED("presign"),
    },
    secrets: { get: NOT_WIRED("secret.get"), issueShortLived: NOT_WIRED("issueShortLived"), set: NOT_WIRED("secret.set") },
    notify: {
      send: (notification) => {
        recorded.notifications.push(notification);
        return Promise.resolve();
      },
    },
    publish: {
      publish: (req, markdown) => {
        recorded.published.push({ doc: req.doc, markdown });
        const receipts: PublishReceipt[] = req.targets.map((target) => ({ target, ref: "ref-1" }));
        return Promise.resolve(receipts);
      },
    },
    memory: {
      store: journalStore,
      masker: createJournalMasker({ policy: defaultPiiPolicy(), dataClass: "dahili" }),
      clock: { now: () => "2026-08-09T09:00:00+03:00" },
    },
    execution: {
      runTurn: (req) => {
        recorded.turns.push(req);
        if (options.runTurn === undefined) throw new Error("fake execution: not wired");
        return Promise.resolve(options.runTurn(req));
      },
      endRun: () => undefined,
    },
    audit: chain,
    idempotency: new InMemoryIdempotency(),
    // Catalog lookups are echoed so a missing key is visible in an assertion
    // instead of silently rendering as an empty string.
    translate: (locale, key, params) => `${key}(${Object.values(params ?? {}).join(",")})`,
    now: () => new Date("2026-08-09T09:00:00+03:00"),
  };

  return { deps, recorded, journalStore, gateStore, chain, patches };
}
