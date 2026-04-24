# @orkestra/contracts

Shared zod schemas + TypeScript types: the single source of truth for data that crosses
service boundaries (API request/response, Temporal payloads, LLM tool schemas).

## Key exports
- `Ticket`, `Run`, `StepExecution`, `Variant`, `KnowledgePack` — zod schemas + inferred types
- `AgentInvocation`, `AgentResult` — agent runtime contracts
- `JiraWebhookEvent`, `GitWebhookEvent` — webhook payload schemas
- `WorkMode`, `Role` — domain enums

## Depends on
`zod`.

## Example
```ts
import { Ticket, type TicketT } from "@orkestra/contracts";

const ticket: TicketT = Ticket.parse(rawPayload);
```

See [../../docs/architecture.md](../../docs/architecture.md) for the data model.
