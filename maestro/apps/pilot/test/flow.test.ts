import { doc, paragraph } from "@maestro/adapter-jira";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootPilot, type PilotStage } from "../src/boot.js";
import { APPROVER_GROUP } from "../src/config.js";
import { cloudFixture, waitFor } from "./helpers.js";

/**
 * End-to-end test of the shortened flow against a FAKE-of-the-real Jira Cloud,
 * entirely offline. The Jira transport is a stateful stub that answers the same
 * REST v3 routes the live site does (shaped by the recorded fixtures), the ADO
 * prop is a real loopback server, and the model is a stub — so what is
 * exercised is the pilot's own wiring: the poll-based gates, masking, the CI
 * signal, and the audit chain. No network, no API spend, no live Jira.
 */

const OPERATOR = "712020:7ee7a2ab-23e7-47aa-a61e-38b79b7eb4d1";
const SITE = "https://uyildiz.atlassian.net";

// PII on purpose: proves the analyst/engineer inputs are masked before they
// leave the machine, exactly as the demo does with its ticket description.
const PII_EMAIL = "pilot.kullanici@bank.example";
const PII_PHONE = "0532 111 22 33";

// -------------------------------------------------------------- stub model

const outbound: string[] = [];

function stubLlmFetch(_url: string, init?: RequestInit): Promise<Response> {
  const raw = typeof init?.body === "string" ? init.body : "";
  outbound.push(raw);
  const body: unknown = JSON.parse(raw);
  const messages = (body as { messages: Array<{ content: string }> }).messages;
  const prompt = messages.map((message) => message.content).join("\n");

  let content: string;
  if (prompt.includes("Schema name: IntakeVerdict")) {
    content = JSON.stringify({ complete: true, missing: [], note: "Ticket geliştirmeye uygun." });
  } else if (prompt.includes("Schema name: AnalysisDoc")) {
    content = JSON.stringify(analysisOutput);
  } else if (prompt.includes("Schema name: CodeDraft")) {
    content = JSON.stringify(codeDraft);
  } else {
    content = "{}";
  }
  return Promise.resolve(
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 900, completion_tokens: 300 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

/**
 * The analyst's output in the REAL template's shape (M108): keyed by the
 * `kurumsal-analiz` template section keys, validated by agent-roles against the
 * generated schema AND the M109 source list. Every claim section carries a
 * source row pointing at the one reference the pilot's context actually holds
 * today — the ticket key — because with an empty knowledge pack a repo_file or
 * repo_card citation would be refused as a fabrication.
 */
const TICKET_KEY = "OPS-6";
const analysisOutput = {
  riskTier: "dusuk",
  riskReason: "Yüzey sınırlı olduğundan risk düşük değerlendirildi.",
  clarificationsUsed: [],
  sections: {
    purpose:
      "İşlem başarılı olduğunda müşteriye e-posta ile makbuz gönderilecek. Böylece şubeye gelen makbuz talepleri azalacak ve self-servis oranı artacak.",
    scope: {
      included: ["Makbuz üretimi", "E-posta gönderimi"],
      excluded: ["SMS makbuz", "mobil ekranlar"],
    },
    impactMatrix: [
      {
        appId: "ugurpay",
        impacted: true,
        summary: "Ödeme onay akışı makbuz e-postasını tetikler.",
        source: "primary_repo_discovery",
      },
    ],
    acceptanceCriteria: [
      "Başarılı işlemde makbuz e-posta ile gider.",
      "Başarısız işlemde makbuz gönderilmez.",
      "Makbuz gönderimi audit kaydına yazılır.",
    ],
    uiApiChanges: [
      { Yüzey: "POST /payments/confirm", Durum: "değişti", "Geriye uyum": "geriye uyumlu" },
    ],
    testApproach:
      "Birim testleri makbuz kurallarını doğrular. Entegrasyon testi e-posta tetiğini uçtan uca kontrol eder.",
    riskAndRollback: {
      risk: "Yanlış makbuz gönderimi müşteriyi yanıltabilir.",
      mitigation: "Doğrulama testleri ve gönderim öncesi kontrol eklenir.",
      rollback: "Özellik bayrağı kapatılır, makbuz tetiği devre dışı bırakılır.",
    },
    sources: [
      { section: "purpose", claim: "e-posta makbuzu gönderilecek", kind: "ticket", ref: TICKET_KEY },
      { section: "scope", claim: "makbuz üretimi ve gönderimi", kind: "ticket", ref: TICKET_KEY },
      { section: "impactMatrix", claim: "ödeme akışı etkileniyor", kind: "ticket", ref: TICKET_KEY },
      { section: "acceptanceCriteria", claim: "başarılı işlemde makbuz gider", kind: "ticket", ref: TICKET_KEY },
      { section: "uiApiChanges", claim: "onay ucu makbuz tetikler", kind: "ticket", ref: TICKET_KEY },
      { section: "testApproach", claim: "makbuz kuralları test edilir", kind: "ticket", ref: TICKET_KEY },
      { section: "riskAndRollback", claim: "yanlış makbuz riski", kind: "ticket", ref: TICKET_KEY },
    ],
    openItems: [],
  },
};

const codeDraft = {
  summary: "Makbuz kuralları için saf bir modül ve testi.",
  implementation: [
    "export function receiptFor(amount, ok) {",
    "  if (typeof amount !== 'number' || amount <= 0) return 'gecersiz';",
    "  return ok ? 'makbuz' : 'yok';",
    "}",
  ].join("\n"),
  test: [
    "import assert from 'node:assert/strict';",
    "import { receiptFor } from '../src/impl.mjs';",
    "assert.equal(receiptFor(100, true), 'makbuz');",
    "assert.equal(receiptFor(100, false), 'yok');",
    "assert.equal(receiptFor(0, true), 'gecersiz');",
    "console.log('OK');",
  ].join("\n"),
};

// --------------------------------------------------- stateful fake Jira Cloud

/**
 * A stub that answers the live REST v3 routes. It records the comments Maestro
 * writes (so the test can assert they were posted to "real" Jira) and always
 * serves an operator `/approve` comment, so BOTH poll-based gates resolve.
 */
function fakeJiraCloud(): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  comments: Array<{ id: string; body: unknown }>;
  attachments: Array<{ filename: string; contentType: string }>;
} {
  const comments: Array<{ id: string; body: unknown }> = [];
  const attachments: Array<{ filename: string; contentType: string }> = [];
  let nextId = 20000;
  let attachId = 10050;
  let labels: string[] = [];

  const issue = cloudFixture("issue-get") as { fields: Record<string, unknown> } & Record<string, unknown>;
  // Inject PII into the description so masking has something real to remove.
  const issueWithPii = {
    ...issue,
    fields: {
      ...issue.fields,
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: `İşlem başarılı olduğunda kullanıcıya e-posta ile makbuz gönderilsin. Pilot kullanıcı: ${PII_EMAIL}, telefon ${PII_PHONE}.`,
              },
            ],
          },
        ],
      },
    },
  };

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
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const body: Record<string, unknown> = bodyText.length > 0 ? JSON.parse(bodyText) : {};

    // Discovery search (bounded JQL).
    if (path === "/rest/api/3/search/jql") return Promise.resolve(json(200, cloudFixture("search-jql")));

    // Group membership check (gate authorisation).
    if (path === "/rest/api/3/group/member") return Promise.resolve(json(200, group));

    // Issue read: full snapshot, or just labels.
    if (path === "/rest/api/3/issue/OPS-6" && method === "GET") {
      if (url.searchParams.get("fields") === "labels") {
        return Promise.resolve(json(200, { fields: { labels } }));
      }
      return Promise.resolve(json(200, issueWithPii));
    }
    // Label diff update.
    if (path === "/rest/api/3/issue/OPS-6" && method === "PUT") {
      const update = body["update"] as { labels?: Array<Record<string, string>> } | undefined;
      for (const op of update?.labels ?? []) {
        if (op["add"]) labels = [...new Set([...labels, op["add"]])];
        if (op["remove"]) labels = labels.filter((l) => l !== op["remove"]);
      }
      return Promise.resolve(json(204, undefined));
    }
    // Attachment upload (M103r): multipart/form-data, no JSON body. Record the
    // file so the test can assert both analysis docs landed on the ticket.
    if (path === "/rest/api/3/issue/OPS-6/attachments" && method === "POST") {
      const form = init?.body;
      if (!(form instanceof FormData)) throw new Error("attachment POST body must be FormData");
      const file = form.get("file");
      if (!(file instanceof Blob)) throw new Error("attachment POST missing file part");
      const filename = file instanceof File ? file.name : "unknown";
      attachments.push({ filename, contentType: file.type });
      const id = String(attachId++);
      return Promise.resolve(json(200, [{ id, filename, size: file.size, mimeType: file.type }]));
    }
    // Comment create.
    if (path === "/rest/api/3/issue/OPS-6/comment" && method === "POST") {
      const id = String(nextId++);
      comments.push({ id, body: body["body"] });
      return Promise.resolve(json(201, { id }));
    }
    // Comment update (progress edit, M75).
    if (/^\/rest\/api\/3\/issue\/OPS-6\/comment\/\d+$/.test(path) && method === "PUT") {
      const id = path.split("/").pop() ?? "";
      const found = comments.find((c) => c.id === id);
      if (found) found.body = body["body"];
      return Promise.resolve(json(200, { id }));
    }
    // Comment list (the poll source): Maestro's own comments plus the standing
    // operator /approve. A fresh `seen` set per gate lets both gates pick it up.
    if (path === "/rest/api/3/issue/OPS-6/comment" && method === "GET") {
      const approve = {
        id: "9001",
        author: { accountId: OPERATOR },
        body: doc(paragraph("/approve")),
        created: "2026-08-10T15:00:00.000+0300",
        updated: "2026-08-10T15:00:00.000+0300",
      };
      return Promise.resolve(json(200, { comments: [...comments.map((c) => ({ ...c, ...marker() })), approve] }));
    }

    throw new Error(`unexpected Jira Cloud call: ${method} ${path}`);
  };

  // Maestro's own comments are never commands (they lack a top-level /command),
  // so they need no created/updated to be skipped — but the parser reads them,
  // so give them timestamps to stay well-formed.
  function marker(): { created: string; updated: string; author: { accountId: string } } {
    return {
      created: "2026-08-10T14:59:00.000+0300",
      updated: "2026-08-10T14:59:00.000+0300",
      author: { accountId: "maestro-app" },
    };
  }

  return { fetchImpl, comments, attachments };
}

describe("pilot kısaltılmış akış — canlı Jira'ya karşı (offline stub)", () => {
  let stage: PilotStage;
  let jira: ReturnType<typeof fakeJiraCloud>;

  beforeAll(async () => {
    jira = fakeJiraCloud();
    stage = await bootPilot({
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

  it("keşif, canlı arama sonucundan maestro ticket'larını getirir", async () => {
    await stage.refreshDiscovery();
    const rows = stage.store.snapshot().discovered;
    expect(rows.length).toBe(6);
    expect(rows[0]!.key).toBe("OPS-6");
  });

  it("iki /approve (canlı Jira yorumu yoklanarak) ile intake'ten merge'e tamamlanır", async () => {
    const running = stage.start("OPS-6");

    // The gates resolve purely from the polled /approve — there is no local
    // box. A gate can open and close between samples, so the predicate also
    // accepts a terminal state (the run reaching the NEXT gate, finishing, or
    // failing) rather than only the transient awaitingGate value.
    const reached = (gate: string): boolean => {
      const s = stage.store.snapshot();
      return s.awaitingGate === gate || s.finished || s.failure !== null;
    };
    await waitFor(() => reached("3"), 20_000, "analiz kapısı");
    await waitFor(() => reached("8"), 30_000, "PR kapısı");

    await running;

    const state = stage.store.snapshot();
    expect(state.failure).toBeNull();
    expect(state.finished).toBe(true);
    expect(state.steps.every((step) => step.state === "tamam")).toBe(true);
    expect(state.browseUrl).toBe(`${SITE}/browse/OPS-6`);
    expect(state.approverGroup).toBe(APPROVER_GROUP);

    // The chain really verified and has records.
    expect(state.audit.verified).toBe(true);
    expect(state.audit.records).toBeGreaterThan(8);

    // The PR exists on the ADO side and is merged.
    const pr = stage.ado.pullRequests().at(-1);
    expect(pr?.status).toBe("completed");

    // Maestro's comments really went to (fake) real Jira.
    const bodies = JSON.stringify(jira.comments.map((c) => c.body));
    expect(bodies).toContain("Analiz hazır");
    expect(bodies).toContain("Tamamlandı");
    // The progress comment was edited in place (M75), not duplicated.
    expect(bodies).toContain("tamamlandı — PR birleşti");

    // M103r: the analysis Word + PDF were attached to the ticket automatically —
    // both files, with the right names and content types, no human drag-and-drop.
    expect(jira.attachments.map((a) => a.filename).sort()).toEqual(["OPS-6-analiz.docx", "OPS-6-analiz.pdf"]);
    const byName = new Map(jira.attachments.map((a) => [a.filename, a.contentType]));
    expect(byName.get("OPS-6-analiz.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(byName.get("OPS-6-analiz.pdf")).toBe("application/pdf");
  }, 90_000);

  it("kişisel veri modele maskesiz gitmedi", () => {
    expect(outbound.length).toBeGreaterThan(0);
    const sent = outbound.join("\n");
    expect(sent).not.toContain(PII_EMAIL);
    expect(sent).not.toContain(PII_PHONE);
    expect(stage.store.snapshot().maskedFields).toBeGreaterThan(0);
  });
});
