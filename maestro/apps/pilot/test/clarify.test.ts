import { AuditChain, InMemoryAuditStore } from "@maestro/audit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootPilot, type PilotStage } from "../src/boot.js";
import { cloudFixture, waitFor } from "./helpers.js";

/**
 * The CLARIFY (intake) gate, end-to-end against a FAKE-of-the-real Jira Cloud,
 * entirely offline. When the intake role judges a ticket too thin to analyse,
 * the pilot must NOT produce an analysis — it posts ONE Turkish clarification
 * comment carrying the open questions and stops, waiting for a human answer.
 *
 * The model is a stub whose intake answer is `complete:false` with two real
 * `missing` questions (its shape gives it nowhere to invent a value). The stub
 * also serves the analyst/engineer schemas so that IF the flow wrongly kept
 * going the test could see it — but it must not: the assertions prove no
 * analysis comment, no attachment, and no code steps ran.
 */

const SITE = "https://uyildiz.atlassian.net";

const MISSING = [
  {
    field: "kabul kriterleri",
    why: "Ticket'ta ölçülebilir kabul kriteri yok.",
    question: "Bu işin başarı ölçütleri neler? Kabul kriterlerini yazar mısınız?",
  },
  {
    field: "kapsam",
    why: "Hangi ekranların etkileneceği belirsiz.",
    question: "Değişiklik hangi ekran veya servisleri kapsıyor?",
  },
];

/** The stub model: intake says incomplete; nothing else should be asked for. */
function stubLlmFetch(_url: string, init?: RequestInit): Promise<Response> {
  const raw = typeof init?.body === "string" ? init.body : "";
  const messages = (JSON.parse(raw) as { messages: Array<{ content: string }> }).messages;
  const prompt = messages.map((message) => message.content).join("\n");

  let content = "{}";
  if (prompt.includes("Schema name: IntakeOutput")) {
    content = JSON.stringify({ complete: false, missing: MISSING });
  } else {
    // If the flow reaches the analyst/engineer, that is the bug this test guards
    // against — surface it as an obviously-wrong (schema-invalid) answer.
    content = JSON.stringify({ unexpected: "clarify gate should have stopped the flow" });
  }
  return Promise.resolve(
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 500, completion_tokens: 100 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

/** A stub answering the live REST v3 routes; records the comments Maestro writes. */
function fakeJiraCloud(): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  comments: Array<{ id: string; body: unknown }>;
  attachments: Array<{ filename: string }>;
} {
  const comments: Array<{ id: string; body: unknown }> = [];
  const attachments: Array<{ filename: string }> = [];
  let nextId = 20000;
  let labels: string[] = [];

  const issue = cloudFixture("issue-get") as { fields: Record<string, unknown> } & Record<string, unknown>;
  // A deliberately thin description — this is the ticket the intake role rejects.
  const thinIssue = {
    ...issue,
    fields: {
      ...issue.fields,
      summary: "Makbuz",
      description: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Makbuz lazım." }] }],
      },
    },
  };

  const json = (status: number, body: unknown): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: body === undefined ? {} : { "content-type": "application/json" },
    });

  const fetchImpl = (rawUrl: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(rawUrl);
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const body: Record<string, unknown> = bodyText.length > 0 ? JSON.parse(bodyText) : {};

    if (path === "/rest/api/3/search/jql") return Promise.resolve(json(200, cloudFixture("search-jql")));

    if (path === "/rest/api/3/issue/OPS-6" && method === "GET") {
      if (url.searchParams.get("fields") === "labels") {
        return Promise.resolve(json(200, { fields: { labels } }));
      }
      return Promise.resolve(json(200, thinIssue));
    }
    if (path === "/rest/api/3/issue/OPS-6" && method === "PUT") {
      const update = body["update"] as { labels?: Array<Record<string, string>> } | undefined;
      for (const op of update?.labels ?? []) {
        if (op["add"]) labels = [...new Set([...labels, op["add"]])];
        if (op["remove"]) labels = labels.filter((l) => l !== op["remove"]);
      }
      return Promise.resolve(json(204, undefined));
    }
    if (path === "/rest/api/3/issue/OPS-6/attachments" && method === "POST") {
      const form = init?.body;
      if (form instanceof FormData) {
        const file = form.get("file");
        if (file instanceof File) attachments.push({ filename: file.name });
      }
      return Promise.resolve(json(200, [{ id: "1", filename: "x", size: 1, mimeType: "x" }]));
    }
    if (path === "/rest/api/3/issue/OPS-6/comment" && method === "POST") {
      const id = String(nextId++);
      comments.push({ id, body: body["body"] });
      return Promise.resolve(json(201, { id }));
    }
    if (/^\/rest\/api\/3\/issue\/OPS-6\/comment\/\d+$/.test(path) && method === "PUT") {
      const id = path.split("/").pop() ?? "";
      const found = comments.find((c) => c.id === id);
      if (found) found.body = body["body"];
      return Promise.resolve(json(200, { id }));
    }
    // The gate poller must never be reached on the clarify path; if it is, this
    // returns only Maestro's own (non-command) comments so nothing resolves.
    if (path === "/rest/api/3/issue/OPS-6/comment" && method === "GET") {
      return Promise.resolve(json(200, { comments: comments.map((c) => ({ ...c, ...marker() })) }));
    }

    throw new Error(`unexpected Jira Cloud call: ${method} ${path}`);
  };

  function marker(): { created: string; updated: string; author: { accountId: string } } {
    return {
      created: "2026-08-10T14:59:00.000+0300",
      updated: "2026-08-10T14:59:00.000+0300",
      author: { accountId: "maestro-app" },
    };
  }

  return { fetchImpl, comments, attachments };
}

describe("pilot clarify geçidi — belirsiz ticket analiz üretmeden netleştirme sorar", () => {
  let stage: PilotStage;
  let jira: ReturnType<typeof fakeJiraCloud>;
  const auditStore = new InMemoryAuditStore();

  beforeAll(async () => {
    jira = fakeJiraCloud();
    stage = await bootPilot({
      audit: new AuditChain({ store: auditStore }),
      env: {},
      scm: "fake",
      uiPort: 0,
      adoPort: 0,
      openRouter: { apiKey: "test-key", baseUrl: "http://127.0.0.1:1" },
      jiraCloud: { baseUrl: SITE, email: "pilot@bank.example", apiToken: "api-token-123" },
      llmFetch: stubLlmFetch,
      jiraFetch: jira.fetchImpl,
      buildDelayMs: 30,
      ciTimeoutMs: 15_000,
      commandPollMs: 20,
    });
  });

  afterAll(async () => {
    await stage.close();
  });

  it("analiz ÜRETMEZ, tek netleştirme yorumu yazar ve sorular yoruma girer", async () => {
    const running = stage.start("OPS-6");
    await waitFor(
      () => stage.store.snapshot().finished || stage.store.snapshot().failure !== null,
      20_000,
      "clarify akışı bitişi",
    );
    await running;

    const state = stage.store.snapshot();
    // A clarify stop is NOT a failure — the run ends cleanly, waiting for a human.
    expect(state.failure).toBeNull();
    expect(state.finished).toBe(true);
    // The flow stopped at step 2: analysis/gate/code steps never ran.
    const stepById = new Map(state.steps.map((s) => [s.id, s.state]));
    expect(stepById.get("2")).toBe("onay"); // waiting on the reporter
    expect(stepById.get("3")).toBe("bekliyor"); // analysis gate never opened
    expect(stepById.get("4")).toBe("bekliyor"); // no code

    const bodies = JSON.stringify(jira.comments.map((c) => c.body));
    // (a) NO analysis was produced/posted.
    expect(bodies).not.toContain("Analiz hazır");
    // (b) a clarification comment WAS posted.
    expect(bodies).toContain("Netleştirme gerekli");
    // (c) every intake question landed in the comment.
    for (const item of MISSING) expect(bodies).toContain(item.question);
    // No analysis Word/PDF was attached on the clarify path.
    expect(jira.attachments).toHaveLength(0);

    // The trail records that the reporter was asked (M98).
    const events = await auditStore.read();
    const asked = events.filter((e) => e.action === "CLARIFICATION_ASKED");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.meta["questionCount"]).toBe(MISSING.length);
    // No analysis-side events (a security scan or PR would mean the flow ran on).
    expect(events.some((e) => e.action === "PR_OPENED")).toBe(false);
  }, 60_000);
});
