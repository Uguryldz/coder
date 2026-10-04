import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTicket } from "./harness.js";
import { Scenario } from "./scenario.js";

/**
 * GitHub has no build webhook into Maestro. 10b now also ASKS the SCM for the
 * published commit's checks, and a repository with no CI at all is not a
 * red build — the verification that ran in 6a stands, and the journal says so.
 * Merging follows the mode: full_auto merges, the rest wait for a human.
 */
let env: TestWorkflowEnvironment;
beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
});
afterAll(async () => {
  await env.teardown();
});

describe("10b without a CI webhook (GitHub path)", () => {
  it("polls the commit's checks and leaves 10b on success", async () => {
    const scenario = new Scenario({ risk: "dusuk" });
    const polls: string[] = [];
    const answers: Array<"pending" | "success"> = ["pending", "pending", "success"];
    const run = await runTicket(env, scenario, {
      pollBuild: async (_ticket, sha) => {
        polls.push(sha);
        return { state: answers.shift() ?? "success", detail: ["build ✓"] };
      },
    });
    expect(run.status).toBe("done");
    expect(polls.length).toBeGreaterThanOrEqual(3);
    expect(polls.every((sha) => sha === "feedface0000")).toBe(true);
    expect(scenario.journal.some((e) => e.title === "CI yeşil")).toBe(true);
  });

  it("a repository with no checks at all passes after the grace window, and the journal says why", async () => {
    const scenario = new Scenario({ risk: "dusuk" });
    let polls = 0;
    const run = await runTicket(env, scenario, {
      pollBuild: async () => {
        polls += 1;
        return { state: "none", detail: [] };
      },
    });
    expect(run.status).toBe("done");
    expect(polls).toBe(3);
    const note = scenario.journal.find((e) => e.title === "CI tanımlı değil");
    expect(note?.detail).toContain("6a");
  });

  it("a failing check sends the same session back to 6a and republishes the fix", async () => {
    const scenario = new Scenario({ risk: "dusuk" });
    const answers: Array<"failure" | "success"> = ["failure", "success"];
    const published: string[] = [];
    const run = await runTicket(env, scenario, {
      pollBuild: async () => ({ state: answers.shift() ?? "success", detail: ["lint ✗"] }),
      publishBranch: async () => {
        published.push("push");
        return { pushed: true, branch: "maestro/pay-101", sha: `sha-${String(published.length)}`, files: 1 };
      },
    });
    expect(run.status).toBe("done");
    expect(published).toHaveLength(2);
    const fix = scenario.engineering.find((e) => e.task.startsWith("CI hatasını düzelt"));
    expect(fix?.task).toContain("lint ✗");
    expect(fix?.resumeToken).toBe("session-1");
  });

  it("a turn that produced nothing hands over instead of opening an empty PR", async () => {
    const scenario = new Scenario({ risk: "dusuk" });
    let prOpened = false;
    const run = await runTicket(env, scenario, {
      publishBranch: async () => ({ pushed: false, branch: "maestro/pay-101", reason: "hiçbir dosya değişmedi" }),
      openPullRequest: async () => {
        prOpened = true;
        return { adoProject: "BANK", adoRepo: "pay", prId: 1 };
      },
    });
    expect(run.status).toBe("handover");
    expect(prOpened).toBe(false);
    expect(scenario.handovers[0]).toContain("hiçbir dosya değişmedi");
  });
});

describe("merging by mode", () => {
  it("waits for a human merge instead of failing, then closes", async () => {
    const scenario = new Scenario({ risk: "dusuk", ci: [{ status: "succeeded", buildId: 901 }] });
    const answers = [
      { mergeSha: null, state: "active" as const, by: null },
      { mergeSha: null, state: "active" as const, by: null },
      { mergeSha: "human1", state: "completed" as const, by: "human" as const },
    ];
    let asked = 0;
    const run = await runTicket(env, scenario, {
      mergePullRequest: async () => {
        asked += 1;
        return answers.shift() ?? { mergeSha: "human1", state: "completed", by: "human" };
      },
    });
    expect(run.status).toBe("done");
    expect(asked).toBe(3);
  });

  it("an abandoned PR is a handover", async () => {
    const scenario = new Scenario({ risk: "dusuk", ci: [{ status: "succeeded", buildId: 901 }] });
    const run = await runTicket(env, scenario, {
      mergePullRequest: async () => ({ mergeSha: null, state: "abandoned", by: null }),
    });
    expect(run.status).toBe("handover");
    expect(scenario.handovers[0]).toContain("terk edildi");
  });
});
