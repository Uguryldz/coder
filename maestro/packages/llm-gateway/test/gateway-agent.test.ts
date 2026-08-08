import { describe, expect, it } from "vitest";
import { AgentRunnerNotWiredError, MSG_QUEUED_QUOTA } from "../src/index.js";
import { build } from "./gateway-fixture.js";
import { stubRunner } from "./helpers.js";

const opts = { workspacePath: "/work/UGURPAY-1", task: "implement the change", mcpServers: ["maestro-mcp"] };

const DONE = [{ finalText: "done", tokensIn: 10, tokensOut: 3, vendorSessionId: "v1" }];

describe("LlmGateway.agentSession (M17 delegation)", () => {
  it("picks the backend, opens a session and delegates the run", async () => {
    const agentRunner = stubRunner(DONE);
    const { gateway, stub } = build({ agentDataClass: "dahili" }, { agentRunner }, []);

    const outcome = await gateway.agentSessionOrQueue(opts);

    if (outcome.status !== "ok") return expect.unreachable("expected an ok outcome");
    expect(outcome.resumeToken).toBe("session-1");
    expect(outcome.finalText).toBe("done");
    expect(outcome.log).toMatchObject({ role: "engineer", driver: "claude-sub", model: "claude-sonnet", usd: null });
    expect(agentRunner.inputs[0]).toEqual({
      driver: "claude-sub",
      model: "claude-sonnet",
      workspacePath: "/work/UGURPAY-1",
      task: "implement the change",
      mcpServers: ["maestro-mcp"],
      vendorSessionId: null,
      credentialRef: "llm/seat1",
    });
    // The gateway itself makes no provider call — execution is Wave 2's job.
    expect(stub.calls).toHaveLength(0);
  });

  it("resumes the same session and hands the vendor handle back", async () => {
    const agentRunner = stubRunner([
      { finalText: "turn 1", tokensIn: 10, tokensOut: 3, vendorSessionId: "v1" },
      { finalText: "turn 2", tokensIn: 5, tokensOut: 2 },
    ]);
    const { gateway } = build(
      {
        agentDataClass: "dahili",
        subscriptionPool: {
          accounts: [
            {
              accountId: "sub-1",
              driver: "claude-sub",
              transport: "anthropic-direct",
              credentialRef: "llm/seat1",
              windows: [{ kind: "5h", costPctPerCall: 1 }],
            },
          ],
        },
      },
      { agentRunner },
      [],
    );

    const first = await gateway.agentSession(opts);
    const second = await gateway.agentSession({ ...opts, resumeToken: first.resumeToken });

    expect(second.resumeToken).toBe(first.resumeToken);
    expect(agentRunner.inputs[1]?.vendorSessionId).toBe("v1");
    expect(second.finalText).toBe("turn 2");
  });

  it("queues an agent turn when the pool is exhausted, without calling the runner", async () => {
    const agentRunner = stubRunner(DONE);
    const { gateway } = build({ agentDataClass: "dahili" }, { agentRunner }, []);
    await gateway.agentSessionOrQueue(opts);

    const queued = await gateway.agentSessionOrQueue(opts);
    expect(queued).toMatchObject({ status: "queued", messageKey: MSG_QUEUED_QUOTA });
    expect(agentRunner.inputs).toHaveLength(1);
  });

  it("refuses to run when no agent runner is wired", async () => {
    const { gateway } = build({}, {}, []);
    await expect(gateway.agentSession(opts)).rejects.toBeInstanceOf(AgentRunnerNotWiredError);
  });

  it("degrades an agent turn when the configured agent data class has no backend", async () => {
    const agentRunner = stubRunner(DONE);
    const { gateway } = build({ agentDataClass: "gizli" }, { agentRunner }, []);

    expect(await gateway.agentSessionOrQueue(opts)).toMatchObject({ status: "degraded", dataClass: "gizli" });
    expect(agentRunner.inputs).toHaveLength(0);
  });
});
