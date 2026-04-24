# @orkestra/worker

Temporal worker process: hosts Orkestra workflows and activity implementations.

## Key exports
- `src/index.ts` — Temporal `Worker.create()` bootstrap, registers activities from
  `@orkestra/workflows/activities` and the workflow bundle from `@orkestra/workflows/workflow`

## Depends on
`@orkestra/config`, `@orkestra/contracts`, `@orkestra/db`, `@orkestra/workflows`,
`@orkestra/agents`, `@orkestra/jira`, `@orkestra/git`, `@orkestra/sandbox`, `@orkestra/slack`,
`@orkestra/testrail`, `@orkestra/llm`, `@orkestra/audit`, `@temporalio/worker`,
`@temporalio/activity`, `@temporalio/client`.

## Usage
```bash
pnpm --filter @orkestra/worker dev     # tsx watch
pnpm --filter @orkestra/worker build
pnpm --filter @orkestra/worker start
```

See [../../docs/workflow.md](../../docs/workflow.md) for the state machine
and [../../docs/runbook.md](../../docs/runbook.md) for operational guidance.
