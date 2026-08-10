import { doc, paragraph } from "@maestro/adapter-jira";
import { afterEach, describe, expect, it } from "vitest";
import { bootPilot, type PilotStage } from "../src/boot.js";
import type { ExecRequest, ExecResult } from "../src/workspace.js";
import { cloudFixture, waitFor } from "./helpers.js";

/**
 * OFFLINE end-to-end test of the PILOT_SCM=github path. Three transports are
 * stubbed and NOTHING touches the network or a real git:
 *   - Jira Cloud   → the same stateful REST stub the fake-ADO flow test uses.
 *   - GitHub REST  → a router that answers repo/ref/pulls/comments + graphql.
 *   - git          → a recording exec runner (no shell-out).
 *
 * It proves the real branch/PR path is exercised (real openPr POST to GitHub),
 * the engineer step issues the git SEQUENCE clone→…→push, the token never
 * appears on a git argv or in a log line, the push credential is short-lived,
 * and a push failure fails the run CLOSED (no PR).
 */

const OPERATOR = "712020:7ee7a2ab-23e7-47aa-a61e-38b79b7eb4d1";
const SITE = "https://uyildiz.atlassian.net";
const TOKEN = "ghp_super_secret_github_token_value_1234567890";

// ------------------------------------------------------------- stub model

function stubLlmFetch(_url: string, init?: RequestInit): Promise<Response> {
  const raw = typeof init?.body === "string" ? init.body : "";
  const messages = (JSON.parse(raw) as { messages: Array<{ content: string }> }).messages;
  const prompt = messages.map((m) => m.content).join("\n");
  let content = "{}";
  if (prompt.includes("Schema name: IntakeVerdict")) {
    content = JSON.stringify({ complete: true, missing: [], note: "Uygun." });
  } else if (prompt.includes("Schema name: AnalysisDoc")) {
    content = JSON.stringify(analysisDoc);
  } else if (prompt.includes("Schema name: CodeDraft")) {
    content = JSON.stringify(codeDraft);
  }
  return Promise.resolve(
    new Response(
      JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

const analysisDoc = {
  templateVersion: "pilot-v3",
  language: "tr",
  purpose: "Ödeme onayında makbuz.",
  scope: { included: ["Makbuz"], excluded: [] },
  impactMatrix: [{ appId: "ugurpay", impacted: true, summary: "Akış.", source: "primary_repo_discovery" }],
  acceptanceCriteria: ["Makbuz gider"],
  uiApiChanges: "POST /pay.",
  testApproach: "Birim.",
  riskAndRollback: { risk: "R", mitigation: "M", rollback: "K" },
  riskTier: "dusuk",
  riskReason: "Sınırlı.",
  clarificationsUsed: [],
};

const codeDraft = {
  summary: "Makbuz modülü.",
  implementation: ["export function ok() {", "  return 'makbuz';", "}"].join("\n"),
  test: [
    "import assert from 'node:assert/strict';",
    "import { ok } from '../src/impl.mjs';",
    "assert.equal(ok(), 'makbuz');",
    "console.log('OK');",
  ].join("\n"),
};

// -------------------------------------------------------- stub Jira Cloud

function fakeJiraCloud(): { fetchImpl: (u: string, i?: RequestInit) => Promise<Response> } {
  const comments: Array<{ id: string; body: unknown }> = [];
  let nextId = 20000;
  let labels: string[] = [];
  const issue = cloudFixture("issue-get") as { fields: Record<string, unknown> } & Record<string, unknown>;
  const group = cloudFixture("group-member-by-name");

  const json = (status: number, body: unknown): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: body === undefined ? {} : { "content-type": "application/json" },
    });

  const fetchImpl = (rawUrl: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(rawUrl);
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body: Record<string, unknown> =
      typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : {};

    if (path === "/rest/api/3/search/jql") return Promise.resolve(json(200, cloudFixture("search-jql")));
    if (path === "/rest/api/3/group/member") return Promise.resolve(json(200, group));
    if (path === "/rest/api/3/issue/OPS-6" && method === "GET") {
      if (url.searchParams.get("fields") === "labels") return Promise.resolve(json(200, { fields: { labels } }));
      return Promise.resolve(json(200, issue));
    }
    if (path === "/rest/api/3/issue/OPS-6" && method === "PUT") {
      const update = body["update"] as { labels?: Array<Record<string, string>> } | undefined;
      for (const op of update?.labels ?? []) {
        if (op["add"]) labels = [...new Set([...labels, op["add"]])];
      }
      return Promise.resolve(json(204, undefined));
    }
    // Attachment upload (M103r) — this fake refuses it (500). The run must still
    // finish: attaching is fail-soft, proven here in a REAL run, not just a unit.
    if (path === "/rest/api/3/issue/OPS-6/attachments" && method === "POST") {
      return Promise.resolve(json(500, { errorMessages: ["attachment store offline"] }));
    }
    if (path === "/rest/api/3/issue/OPS-6/comment" && method === "POST") {
      const id = String(nextId++);
      comments.push({ id, body: body["body"] });
      return Promise.resolve(json(201, { id }));
    }
    if (/^\/rest\/api\/3\/issue\/OPS-6\/comment\/\d+$/.test(path) && method === "PUT") {
      return Promise.resolve(json(200, { id: path.split("/").pop() }));
    }
    if (path === "/rest/api/3/issue/OPS-6/comment" && method === "GET") {
      const approve = {
        id: "9001",
        author: { accountId: OPERATOR },
        body: doc(paragraph("/approve")),
        created: "2026-08-10T15:00:00.000+0300",
        updated: "2026-08-10T15:00:00.000+0300",
      };
      const marker = { created: "2026-08-10T14:59:00.000+0300", updated: "2026-08-10T14:59:00.000+0300", author: { accountId: "maestro-app" } };
      return Promise.resolve(json(200, { comments: [...comments.map((c) => ({ ...c, ...marker })), approve] }));
    }
    throw new Error(`unexpected Jira call: ${method} ${path}`);
  };
  return { fetchImpl };
}

// ------------------------------------------------------------ stub GitHub

interface GithubStub {
  fetchImpl: (u: string, i?: RequestInit) => Promise<Response>;
  calls: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }>;
}

function fakeGithub(): GithubStub {
  const calls: GithubStub["calls"] = [];
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = (rawUrl: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(rawUrl);
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body: unknown =
      typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, headers: { ...((init?.headers ?? {}) as Record<string, string>) }, body });

    if (path.endsWith("/graphql")) {
      return Promise.resolve(
        json(200, { data: { markPullRequestReadyForReview: { pullRequest: { number: 77, isDraft: false } } } }),
      );
    }
    // GET /repos/{owner}/{repo}
    if (/\/repos\/[^/]+\/[^/]+$/.test(path) && method === "GET") {
      return Promise.resolve(json(200, { name: "ugurpay", owner: { login: "ugurbank" }, default_branch: "main" }));
    }
    // GET .../git/ref/heads/main
    if (path.includes("/git/ref/") && method === "GET") {
      return Promise.resolve(json(200, { ref: "refs/heads/main", object: { type: "commit", sha: "f".repeat(40) } }));
    }
    // POST .../git/refs
    if (path.endsWith("/git/refs") && method === "POST") {
      const ref = (body as { ref: string }).ref;
      return Promise.resolve(json(201, { ref, object: { sha: "f".repeat(40) } }));
    }
    // POST .../pulls
    if (path.endsWith("/pulls") && method === "POST") {
      return Promise.resolve(json(201, { number: 77, node_id: "PR_kw1", state: "open", draft: true }));
    }
    // GET .../pulls/77
    if (/\/pulls\/77$/.test(path) && method === "GET") {
      return Promise.resolve(json(200, { number: 77, node_id: "PR_kw1", state: "open", draft: false }));
    }
    // GET .../pulls/77/comments
    if (/\/pulls\/77\/comments$/.test(path) && method === "GET") {
      return Promise.resolve(json(200, []));
    }
    throw new Error(`unexpected GitHub call: ${method} ${path}`);
  };
  return { fetchImpl, calls };
}

// -------------------------------------------------------------- git exec

interface ExecStub {
  exec: (req: ExecRequest) => Promise<ExecResult>;
  git: ExecRequest[];
  failPush: boolean;
}

function recordingExec(): ExecStub {
  const git: ExecRequest[] = [];
  const stub: ExecStub = {
    git,
    failPush: false,
    exec: (req: ExecRequest): Promise<ExecResult> => {
      // The node test run still goes through this runner; only record git.
      if (req.file === "git") {
        git.push(req);
        if (stub.failPush && req.args[0] === "push") {
          return Promise.resolve({ ok: false, exitCode: 128, stderr: "remote rejected", stdout: "" });
        }
        const sha = "a".repeat(40);
        return Promise.resolve({
          ok: true,
          exitCode: 0,
          stdout: req.args[0] === "rev-parse" ? `${sha}\n` : "",
          stderr: "",
        });
      }
      // The generated test really runs (proves the test gate stays real).
      return Promise.resolve({ ok: true, exitCode: 0, stdout: "OK", stderr: "" });
    },
  };
  return stub;
}

// ----------------------------------------------------------------- test

describe("pilot github SCM path — gerçek dal/PR + gerçek git push (offline)", () => {
  let stage: PilotStage | null = null;
  afterEach(async () => {
    if (stage) await stage.close();
    stage = null;
  });

  it("intake→push→PR: git SEQUENCE issued, real PR opened, token never leaks", async () => {
    const logs: string[] = [];
    const exec = recordingExec();
    const github = fakeGithub();
    // Rebuild boot with a shared github stub so we can inspect its calls.
    stage = await bootPilot({
      uiPort: 0,
      adoPort: 0,
      scm: "github",
      openRouter: { apiKey: "test-key", baseUrl: "http://127.0.0.1:1" },
      jiraCloud: { baseUrl: SITE, email: "pilot@bank.example", apiToken: "api-token-123" },
      github: {
        owner: "ugurbank",
        repo: "ugurpay",
        token: TOKEN,
        apiBaseUrl: "https://api.github.com",
        graphqlUrl: "https://api.github.com/graphql",
        gitBaseUrl: "https://github.com",
      },
      githubFetch: github.fetchImpl,
      llmFetch: stubLlmFetch,
      jiraFetch: fakeJiraCloud().fetchImpl,
      workspaceOptions: { exec: exec.exec },
      buildDelayMs: 20,
      ciTimeoutMs: 15_000,
      commandPollMs: 20,
    });
    const orig = stage.store.log.bind(stage.store);
    stage.store.log = (level, line) => {
      logs.push(line);
      orig(level, line);
    };

    const running = stage.start("OPS-6");
    const reached = (gate: string): boolean => {
      const s = stage!.store.snapshot();
      return s.awaitingGate === gate || s.finished || s.failure !== null;
    };
    await waitFor(() => reached("3"), 20_000, "analiz kapısı");
    await waitFor(() => reached("8"), 30_000, "PR kapısı");
    await running;

    const s = stage.store.snapshot();
    expect(s.failure).toBeNull();
    expect(s.finished).toBe(true);

    // The git sequence really ran, in order.
    expect(exec.git.map((c) => c.args[0])).toEqual([
      "clone",
      "checkout",
      "add",
      "commit",
      "push",
      "rev-parse",
    ]);
    // A REAL PR was POSTed to GitHub.
    const prPost = github.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"));
    expect(prPost).toBeDefined();
    expect((prPost!.body as { head: string }).head).toBe("feature/OPS-6");

    // The token never appears on a git argv, nor in any log line.
    for (const call of exec.git) expect(call.args.join(" ")).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(TOKEN);

    // The token DID ride the git env (as the ephemeral extraHeader) — proving
    // the push was actually authenticated out-of-band.
    const push = exec.git.find((c) => c.args[0] === "push")!;
    const header = push.env?.["GIT_CONFIG_VALUE_0"] ?? "";
    const b64 = header.split(" ").pop() ?? "";
    expect(Buffer.from(b64, "base64").toString("utf8")).toContain(TOKEN);
  }, 90_000);

  it("push failure fails the run CLOSED — no PR opened", async () => {
    const logs: string[] = [];
    const exec = recordingExec();
    exec.failPush = true;
    const github = fakeGithub();
    stage = await bootPilot({
      uiPort: 0,
      adoPort: 0,
      scm: "github",
      openRouter: { apiKey: "test-key", baseUrl: "http://127.0.0.1:1" },
      jiraCloud: { baseUrl: SITE, email: "pilot@bank.example", apiToken: "api-token-123" },
      github: {
        owner: "ugurbank",
        repo: "ugurpay",
        token: TOKEN,
        apiBaseUrl: "https://api.github.com",
        graphqlUrl: "https://api.github.com/graphql",
        gitBaseUrl: "https://github.com",
      },
      githubFetch: github.fetchImpl,
      llmFetch: stubLlmFetch,
      jiraFetch: fakeJiraCloud().fetchImpl,
      workspaceOptions: { exec: exec.exec },
      buildDelayMs: 20,
      ciTimeoutMs: 15_000,
      commandPollMs: 20,
    });
    const orig = stage.store.log.bind(stage.store);
    stage.store.log = (level, line) => {
      logs.push(line);
      orig(level, line);
    };

    const running = stage.start("OPS-6");
    const done = (): boolean => {
      const s = stage!.store.snapshot();
      return s.failure !== null || s.finished;
    };
    const reached3 = (): boolean => stage!.store.snapshot().awaitingGate === "3" || done();
    await waitFor(reached3, 20_000, "analiz kapısı");
    await waitFor(done, 30_000, "sonuç");
    await running;

    const s = stage.store.snapshot();
    expect(s.failure).not.toBeNull();
    expect(s.finished).toBe(false);
    // No PR was ever POSTed — the push failed first.
    expect(github.calls.some((c) => c.method === "POST" && c.path.endsWith("/pulls"))).toBe(false);
    // The token never leaked into the failure log.
    expect(logs.join("\n")).not.toContain(TOKEN);
  }, 90_000);
});
