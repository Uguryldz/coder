# @orkestra/workflows

Temporal workflow + activity definitions for the Orkestra run state machine
(intake -> analyst -> dev -> qa -> release, with human gates between stages).

## Key exports
- `./workflow` — `orkestraRunWorkflow(input)` top-level workflow
- `./activities` — activity implementations bound into the worker
- `./signals` — `approveGate`, `rejectGate`, `retryStep`, `cancelRun` signals
- `./` (index) — re-exports of public types

## Depends on
`@orkestra/config`, `@orkestra/contracts`, `@orkestra/db`, `@orkestra/agents`,
`@orkestra/audit`, `@orkestra/pii`, `@orkestra/jira`, `@orkestra/git`,
`@orkestra/sandbox`, `@orkestra/slack`, `@orkestra/testrail`,
`@temporalio/{workflow,activity,worker,client}`.

## Example
```ts
import { Client } from "@temporalio/client";
import type { orkestraRunWorkflow } from "@orkestra/workflows/workflow";

const client = new Client();
await client.workflow.start<typeof orkestraRunWorkflow>("orkestraRunWorkflow", {
  args: [{ runId, ticketKey }], taskQueue: "orkestra", workflowId: `run-${runId}`,
});
```

See [../../docs/workflow.md](../../docs/workflow.md) for the state machine.
