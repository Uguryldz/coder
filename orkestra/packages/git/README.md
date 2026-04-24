# @orkestra/git

Provider-agnostic Git client: GitHub, GitLab, Bitbucket. Branches, commits, PRs, status
checks, and webhook signature verification.

## Key exports
- `gitClient(provider)` — returns a unified client for the configured provider
- `createBranch`, `openPullRequest`, `postComment`, `setStatusCheck`
- `verifyWebhook(provider, headers, body)` — HMAC verification

## Depends on
`@orkestra/config`, `axios`, `zod`.

## Example
```ts
import { gitClient } from "@orkestra/git";

const gh = gitClient("github");
await gh.openPullRequest({ repo, head: "feat/ABC-123", base: "main", title });
```

See [../../docs/integrations.md](../../docs/integrations.md) for supported providers.
