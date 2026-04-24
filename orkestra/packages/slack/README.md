# @orkestra/slack

Minimal Slack webhook + Web API adapter for run notifications and approval requests.

## Key exports
- `postMessage(channel, blocks)` — post to a channel
- `postApprovalRequest(channel, run, approver)` — render an approval card
- `verifySlackSignature(headers, body)` — interaction signature check

## Depends on
`@orkestra/config`, `axios`.

## Example
```ts
import { postMessage } from "@orkestra/slack";
await postMessage("#orkestra-runs", [{ type: "section", text: { type: "mrkdwn", text } }]);
```

See [../../docs/integrations.md](../../docs/integrations.md) for Slack app setup.
