# @orkestra/config

Typed runtime configuration + logger. Parses `process.env` with zod and returns an
immutable `env` object. Exports a pino logger.

## Key exports
- `env` — validated environment (DB, Redis, Temporal, Jira, LLM keys, etc.)
- `loadEnv(overrides?)` — re-parse env (test helper)
- `./logger` — `logger` (pino) with pretty transport in development

## Depends on
`zod`, `pino`, `pino-pretty`.

## Example
```ts
import { env } from "@orkestra/config";
import { logger } from "@orkestra/config/logger";

logger.info({ url: env.JIRA_BASE_URL }, "starting");
```

See [../../docs/install.md](../../docs/install.md) for the full env matrix.
