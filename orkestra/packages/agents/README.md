# @orkestra/agents

Runtime for invoking AI agents: resolves variant + loads knowledge pack + calls LLM +
records StepExecution + audit.

## Key exports
- `runAgent(invocation)` — primary entry point
- `loadKnowledgePack(variantId)` — attached rules + conventions + domain + examples + glossary
- `resolveVariant(role, ticket)` — routing rule lookup
- `detectWorkMode(ticket)` — label-driven work mode

## Depends on
`@orkestra/contracts`, `@orkestra/db`, `@orkestra/llm`, `@orkestra/pii`, `@orkestra/audit`,
`@orkestra/config`, `@aws-sdk/client-s3`, `zod`.

## Example
```ts
import { runAgent, resolveVariant } from "@orkestra/agents";

const variant = await resolveVariant("analyst", ticket);
const result = await runAgent({ runId, stepId, variant, ticket, input });
```

See [../../docs/workflow.md](../../docs/workflow.md) for the larger picture.
