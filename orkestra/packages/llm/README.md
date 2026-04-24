# @orkestra/llm

LLM invocation layer: Anthropic SDK wrapper, prompt assembly, token/cost accounting,
Redis rate-limit, deterministic mock for tests.

## Key exports
- `callLLM(request)` — primary entry point (real or mock based on env)
- `buildPrompt(variant, ticket, knowledge)` — prompt template assembly
- `priceUsage(usage, model)` — token -> USD cost
- `rateLimit(key, limits)` — Redis token-bucket
- `mockLLM(fixtures)` — deterministic fixture provider

## Depends on
`@anthropic-ai/sdk`, `@orkestra/config`, `@orkestra/contracts`, `ioredis`, `zod`.

## Example
```ts
import { callLLM } from "@orkestra/llm";
const { text, usage } = await callLLM({ model, system, messages, tools });
```

See [../../docs/architecture.md](../../docs/architecture.md) for model routing.
