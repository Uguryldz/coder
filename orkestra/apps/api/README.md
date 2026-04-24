# @orkestra/api

Fastify HTTP API for Jira AI Orkestra: ingests Jira webhooks, exposes run/workflow REST, signals Temporal.

## Key routes
- `POST /webhooks/jira` — Jira issue + comment events
- `POST /runs` — start an Orkestra run for a ticket
- `GET /runs/:id` — fetch run state + steps
- `POST /runs/:id/signal` — forward signals (approve, reject, retry) to Temporal

## Depends on
`@orkestra/config`, `@orkestra/contracts`, `@orkestra/db`, `@orkestra/jira`, `@orkestra/git`,
`@orkestra/workflows`, `@orkestra/audit`, `@orkestra/agents`, `@temporalio/client`, `fastify`.

## Usage
```bash
pnpm --filter @orkestra/api dev       # tsx watch on src/index.ts
pnpm --filter @orkestra/api build     # emit dist/
pnpm --filter @orkestra/api start     # node dist/index.js
```

See [../../docs/architecture.md](../../docs/architecture.md) for the service topology
and [../../docs/integrations.md](../../docs/integrations.md) for webhook payload specs.
