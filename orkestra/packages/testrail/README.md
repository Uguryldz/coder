# @orkestra/testrail

TestRail REST adapter: create/update test cases, attach runs, and close results from
agent-produced test plans.

## Key exports
- `testrailClient()` — authenticated REST client
- `createCase(sectionId, payload)`, `updateCase(caseId, payload)`
- `addResultForCase(runId, caseId, status, comment)`
- `linkToJira(caseId, issueKey)`

## Depends on
`@orkestra/config`, `@orkestra/contracts`, `axios`.

## Example
```ts
import { testrailClient } from "@orkestra/testrail";
const tr = testrailClient();
await tr.addResultForCase(runId, caseId, "passed", "Orkestra sandbox run OK");
```

See [../../docs/integrations.md](../../docs/integrations.md) for TestRail setup.
