# @orkestra/jira

Jira Cloud REST + webhook adapter: fetch tickets, transition status, post ADF comments,
verify webhook payloads.

## Key exports
- `jiraClient()` — authenticated REST client
- `getTicket(key)`, `transition(key, targetStatus)`, `addComment(key, adf)`
- `toADF(markdown)` — Markdown -> Atlassian Document Format
- `verifyWebhook(headers, body)` — signature check
- `JiraStatus` — status state machine helpers

## Depends on
`@orkestra/config`, `@orkestra/contracts`, `axios`, `zod`.

## Example
```ts
import { jiraClient, toADF } from "@orkestra/jira";
const jira = jiraClient();
await jira.addComment("ABC-123", toADF("Analyst finished draft spec."));
```

See [../../docs/integrations.md](../../docs/integrations.md) for Jira setup.
