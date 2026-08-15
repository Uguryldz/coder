import { WorkflowExecutionAlreadyStartedError, type Client } from "@temporalio/client";
import { describe, expect, it } from "vitest";
import { TemporalRunGateway, type OpenedRun } from "../src/temporal-gateway.js";

/**
 * `onRunOpened` — the hook that opens a run's `WorkflowRun` row.
 *
 * This exists because of a real deployment state: `signalWithStart` started
 * executions, nothing wrote a run row, and every activity then failed with
 * `RunNotFoundError` against a worker that looked healthy. What is asserted
 * here is the one distinction that failure needed — the hook fires when a
 * start CREATED an execution and stays quiet when the caller merely joined a
 * live one.
 *
 * The client is a hand-built double rather than a Temporal test environment:
 * the behaviour under test is this class's branching, not the server's.
 */

function gatewayWith(
  workflow: Partial<Client["workflow"]>,
  onRunOpened?: (run: OpenedRun) => Promise<void>,
): TemporalRunGateway {
  const client = { workflow } as unknown as Client;
  return new TemporalRunGateway({
    client,
    ...(onRunOpened === undefined ? {} : { onRunOpened }),
  });
}

const INPUT = {
  ticket: "OPS-7",
  appId: "payments",
  mode: "ai_assist",
  dataClass: "gizli",
} as const;

describe("TemporalRunGateway.signalWithStart — opening the run row", () => {
  it("opens the row when a plain start creates the execution", async () => {
    const opened: OpenedRun[] = [];
    const gateway = gatewayWith(
      { start: () => Promise.resolve({}) } as unknown as Partial<Client["workflow"]>,
      async (run) => void opened.push(run),
    );

    const outcome = await gateway.signalWithStart({ ...INPUT });

    expect(outcome.started).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      runId: outcome.workflowId,
      ticket: "OPS-7",
      appId: "payments",
      mode: "ai_assist",
      dataClass: "gizli",
    });
  });

  it("does not open a second row when the ticket already has a run", async () => {
    // The losing side of two racing webhook deliveries. Temporal collapsed
    // them into one execution; a row here would be the duplicate.
    const opened: OpenedRun[] = [];
    const gateway = gatewayWith(
      {
        start: () =>
          Promise.reject(
            new WorkflowExecutionAlreadyStartedError("already started", "maestro-OPS-7", "ticketWorkflow"),
          ),
      } as unknown as Partial<Client["workflow"]>,
      async (run) => void opened.push(run),
    );

    const outcome = await gateway.signalWithStart({ ...INPUT });

    expect(outcome.started).toBe(false);
    expect(opened).toHaveLength(0);
  });

  it("propagates a failure to open the row", async () => {
    // A started execution whose row was not written fails one activity later,
    // far from the cause. Reporting "started" for it would hide that.
    const gateway = gatewayWith({ start: () => Promise.resolve({}) } as unknown as Partial<Client["workflow"]>, () =>
      Promise.reject(new Error("db down")),
    );

    await expect(gateway.signalWithStart({ ...INPUT })).rejects.toThrow("db down");
  });

  it("works without a hook — the gateway stays usable unwired", async () => {
    const gateway = gatewayWith({ start: () => Promise.resolve({}) } as unknown as Partial<Client["workflow"]>);
    await expect(gateway.signalWithStart({ ...INPUT })).resolves.toMatchObject({ started: true });
  });
});
