# @orkestra/sandbox

Ephemeral Docker sandboxes for running agent-generated code, tests, and security scans.
Manages a capacity pool, dependency cache, and repo map.

## Key exports
- `createSandbox(spec)` — spin up a container, mount repo, apply `orkestra.yaml`
- `runInSandbox(id, cmd)` — exec with streamed logs
- `destroySandbox(id)` — teardown + reclaim capacity
- `loadOrkestraYaml(repoDir)` — parse the per-repo manifest
- `attributeCommit(sandboxId, author)` — commit attribution helper
- `scanSecurity(sandboxId)` — SAST/secret scan pass

## Depends on
`@orkestra/config`, `@orkestra/contracts`, `dockerode`, `ioredis`, `js-yaml`,
`tar-stream`, `zod`.

## Example
```ts
import { createSandbox, runInSandbox } from "@orkestra/sandbox";
const s = await createSandbox({ repo, ref: "feat/ABC-123" });
await runInSandbox(s.id, ["pnpm", "test"]);
```

See [../../docs/architecture.md](../../docs/architecture.md) for sandbox topology.
