# @orkestra/db

Prisma client + migrations for the Orkestra Postgres schema (runs, steps, variants,
knowledge packs, audit, approvals).

## Key exports
- `prisma` — shared `PrismaClient` singleton
- `Prisma` — namespaced enums/types re-exported from `@prisma/client`

## Scripts
- `pnpm --filter @orkestra/db generate` — run `prisma generate`
- `pnpm --filter @orkestra/db migrate` — `prisma migrate deploy`
- `pnpm --filter @orkestra/db migrate:dev` — dev migration
- `pnpm --filter @orkestra/db studio` — Prisma Studio
- `pnpm --filter @orkestra/db seed` — seed baseline data

## Depends on
`@prisma/client`, `prisma`, `tsx`.

## Example
```ts
import { prisma } from "@orkestra/db";
const run = await prisma.run.findUnique({ where: { id } });
```

Schema lives in `prisma/schema.prisma`. See [../../docs/architecture.md](../../docs/architecture.md).
