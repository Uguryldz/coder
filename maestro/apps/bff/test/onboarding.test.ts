import { describe, expect, it } from "vitest";
import type { OnboardingOptionsRecord, OnboardingSampleTicket } from "../src/onboarding-models.js";
import { ONBOARDING_PROPOSAL_PREFIX } from "../src/routes/onboarding.js";
import { harness, TEST_PASSWORD, type Harness } from "./helpers.js";

/**
 * The onboarding wizard (M93/M102).
 *
 * The three endpoints exist to make ONE decision safe: binding a Jira project
 * to a repository decides where an agent will be allowed to push code. So the
 * tests below are mostly about refusals — an unknown repo, a project somebody
 * already owns, a platform that does not match, a stopped platform — and about
 * the one positive property that matters, that submitting produces a PROPOSAL
 * and changes nothing.
 */

const OPTIONS: OnboardingOptionsRecord = {
  projects: [
    { projectKey: "UGURPAY", state: "active" },
    { projectKey: "NEWPROJ", state: null },
    { projectKey: "DRAFTED", state: "draft" },
    { projectKey: "REHEARSE", state: "dry_run" },
  ],
  repos: [
    { appId: "ugurpay", repo: "Odeme/_git/ugurpay", platform: "linux-node" },
    { appId: "cards", repo: "Kart/_git/cards", platform: "linux-java" },
  ],
  platforms: ["linux-java", "linux-node"],
};

/**
 * A project's real run history, as `WorkflowRun` rows would supply it. Each
 * `match` is a genuine `MatchResult` — the dry run reads these rather than
 * re-deciding, so the fixture is where the three tiers actually come from.
 */
const SAMPLES = new Map<string, readonly OnboardingSampleTicket[]>([
  [
    "NEWPROJ",
    [
      { ticketKey: "NEWPROJ-1", appId: "cards", match: { via: "rule", ruleId: "r-1", appId: "cards" } },
      { ticketKey: "NEWPROJ-2", appId: "cards", match: { via: "rule", ruleId: "r-1", appId: "cards" } },
      {
        ticketKey: "NEWPROJ-3",
        appId: "cards",
        match: { via: "ai_suggestion", appId: "cards", confidence: 0.8, validatedAtGate: true },
      },
      {
        ticketKey: "NEWPROJ-4",
        appId: "cards",
        match: { via: "human", appId: "cards", assignedBy: "ayse", channel: "studio" },
      },
      // No recorded match at all: the run started before matching resolved.
      { ticketKey: "NEWPROJ-5", appId: null, match: null },
      // A corrupt column. Fail-closed: it must land in `unresolved`.
      { ticketKey: "NEWPROJ-6", appId: null, match: { via: "rule" } },
      // The same ticket twice — a retry. It is ONE ticket in the answer.
      { ticketKey: "NEWPROJ-1", appId: "cards", match: { via: "rule", ruleId: "r-9", appId: "cards" } },
    ],
  ],
]);

async function wizard(): Promise<Harness> {
  return harness({ onboarding: OPTIONS, samples: SAMPLES });
}

async function adminToken(app: Harness): Promise<string> {
  await app.addUser({ username: "ayse.kaya", roles: ["admin"], groups: ["maestro-admins"] });
  return app.login("ayse.kaya");
}

describe("GET /onboarding/options", () => {
  it("returns the three flat lists the wizard's selects are built from", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "GET",
      url: "/onboarding/options",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      jiraProjects: ["UGURPAY", "NEWPROJ", "DRAFTED", "REHEARSE"],
      adoRepos: ["ugurpay", "cards"],
      platforms: ["linux-java", "linux-node"],
    });
  });

  it("refuses an anonymous caller", async () => {
    const app = await wizard();
    const response = await app.app.inject({ method: "GET", url: "/onboarding/options" });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a developer: onboarding is an admin surface (M86)", async () => {
    const app = await wizard();
    await app.addUser({ username: "dev", roles: ["developer"] });
    const token = await app.login("dev");

    const response = await app.app.inject({
      method: "GET",
      url: "/onboarding/options",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("role_required");
  });

  it("caps the page size rather than accepting an unbounded read", async () => {
    const app = await wizard();
    const token = await adminToken(app);
    const response = await app.app.inject({
      method: "GET",
      url: "/onboarding/options?limit=5000",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_page");
  });
});

describe("POST /onboarding/dry-run", () => {
  it("sorts a project's real history into the three M99 tiers", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding/dry-run",
      headers: { authorization: `Bearer ${token}` },
      payload: { jiraProject: "NEWPROJ", adoRepo: "cards" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Tier 1: matched by an explicit rule. NEWPROJ-1 appears once despite two runs.
    expect(body.byRule).toEqual(["NEWPROJ-1", "NEWPROJ-2"]);
    // Tier 2: the AI guessed, or a human assigned by hand.
    expect(body.bySuggestion).toEqual(["NEWPROJ-3", "NEWPROJ-4"]);
    // Tier 3: no match, and a corrupt match — both need a person.
    expect(body.unresolved).toEqual(["NEWPROJ-5", "NEWPROJ-6"]);
    expect(body.sampled).toBe(6);
  });

  it("reports an empty history as nothing proved, not as a clean run", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding/dry-run",
      headers: { authorization: `Bearer ${token}` },
      payload: { jiraProject: "DRAFTED", adoRepo: "cards" },
    });

    expect(response.statusCode).toBe(200);
    // `sampled: 0` is the field that distinguishes "nothing to replay" from
    // "everything resolved". Three empty buckets alone would read as success.
    expect(response.json()).toMatchObject({
      byRule: [],
      bySuggestion: [],
      unresolved: [],
      sampled: 0,
    });
  });

  it("refuses a repository that is not in the registry", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding/dry-run",
      headers: { authorization: `Bearer ${token}` },
      payload: { jiraProject: "NEWPROJ", adoRepo: "no-such-repo" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("unknown_app");
  });

  it("refuses a project that is already live rather than warning about it", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding/dry-run",
      headers: { authorization: `Bearer ${token}` },
      payload: { jiraProject: "UGURPAY", adoRepo: "cards" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("project_already_bound");
  });

  it("treats a rehearsal in progress as taken", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding/dry-run",
      headers: { authorization: `Bearer ${token}` },
      payload: { jiraProject: "REHEARSE", adoRepo: "cards" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("refuses an unknown field rather than silently dropping it", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding/dry-run",
      headers: { authorization: `Bearer ${token}` },
      payload: { jiraProject: "NEWPROJ", adoRepo: "cards", sampelSize: 5 },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("POST /onboarding", () => {
  const DRAFT = {
    jiraProject: "NEWPROJ",
    adoRepo: "cards",
    platform: "linux-java",
    triggerMode: "opt_in",
    gateSet: "risk_tiered",
    mergeMode: "human",
  } as const;

  it("files a proposal and binds nothing", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: DRAFT,
    });

    // 202, not 201: nothing was created. A second human has to confirm.
    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.status).toBe("pending_four_eyes");
    expect(body.approverGroup).toBe("maestro-admins");
    expect(typeof body.proposalId).toBe("string");

    // The binding itself is untouched: the project is still unbound.
    const pending = await app.params.pending();
    const proposal = pending.find((entry) => entry.key === ONBOARDING_PROPOSAL_PREFIX);
    expect(proposal).toBeDefined();
    expect(proposal?.scopeRef).toBe("NEWPROJ");
    expect(proposal?.value).toMatchObject({ appId: "cards", triggerMode: "opt_in" });
  });

  it("writes an audit record naming the project and the app", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: DRAFT,
    });

    const events = await app.auditStore.read();
    const entry = events.find((event) => event.subject === "onboarding:NEWPROJ");
    expect(entry).toBeDefined();
    expect(entry?.meta).toMatchObject({ appId: "cards", projectKey: "NEWPROJ" });
  });

  it("refuses when the kill switch is on (M58)", async () => {
    const app = await wizard();
    const token = await adminToken(app);
    await app.killSwitch.set({
      level: "all",
      actor: "ops@corp",
      reason: "incident",
      at: "2026-08-09T09:00:00.000Z",
    });

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: DRAFT,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("kill_switch");
    expect(await app.params.pending()).toEqual([]);
  });

  it("refuses a platform that is not the repository's own", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      // `cards` is linux-java; the draft carries a stale linux-node from step 2.
      payload: { ...DRAFT, platform: "linux-node" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("platform_mismatch");
  });

  it("refuses a second person's proposal for the same project", async () => {
    const app = await wizard();
    const first = await adminToken(app);
    await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${first}` },
      payload: DRAFT,
    });

    await app.addUser({ username: "mert.demir", roles: ["tech-lead"] });
    const second = await app.login("mert.demir");
    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${second}` },
      payload: DRAFT,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("proposal_open");
  });

  it("refuses a developer", async () => {
    const app = await wizard();
    await app.addUser({ username: "dev2", roles: ["developer"] });
    const token = await app.login("dev2", TEST_PASSWORD);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: DRAFT,
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses a draft missing a required choice", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: { ...DRAFT, platform: "" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_onboarding_body");
  });
});
