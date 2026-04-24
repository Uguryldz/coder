# @orkestra/audit

Append-only audit log: records who/what/when for every LLM call, gate decision,
and external integration call. Backed by Postgres via `@orkestra/db`.

## Key exports
- `recordAudit(event)` — write an audit event
- `listAudit(filter)` — query events by run, actor, or kind
- `AuditEvent` — zod schema for event payloads

## Depends on
`@orkestra/db`, `@orkestra/config`.

## Example
```ts
import { recordAudit } from "@orkestra/audit";

await recordAudit({
  runId, actor: "agent:analyst", kind: "llm.call", payload: { tokens, cost },
});
```

See [../../docs/architecture.md](../../docs/architecture.md) for the audit model.
