# @orkestra/studio

Next.js 15 app (App Router) for Orkestra operators: run cockpit, agent configuration,
knowledge pack editor, approval queue. Uses Refine + shadcn/Radix + Tiptap.

## Key surfaces
- `/runs` — live run board with step timeline
- `/agents` — variants, routing rules, knowledge packs
- `/approvals` — human-gate queue
- `/settings` — projects, integrations, LLM keys
- Auth via `next-auth` (credentials + SSO)

## Depends on
`@orkestra/config`, `@orkestra/contracts`, `@orkestra/db`, Refine, React Query, Radix UI,
Tiptap, Monaco, Tailwind.

## Usage
```bash
pnpm --filter @orkestra/studio dev      # next dev -p 3100
pnpm --filter @orkestra/studio build
pnpm --filter @orkestra/studio start    # next start -p 3100
```

See [../../docs/agent-studio.md](../../docs/agent-studio.md) for the UX spec.
