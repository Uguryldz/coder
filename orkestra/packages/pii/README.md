# @orkestra/pii

Zero-dependency PII scrubber: redacts emails, phone numbers, API keys, JWTs, and common
credentials before text is sent to external LLMs or stored in logs.

## Key exports
- `scrubPII(text, opts?)` — returns redacted string + list of matches
- `PIIKind` — tagged union for detected entity types
- `RE_EMAIL`, `RE_PHONE`, `RE_JWT`, ... — exported regex constants

## Depends on
(none — stdlib only)

## Example
```ts
import { scrubPII } from "@orkestra/pii";
const { text, matches } = scrubPII(rawComment);
// text safe to send to LLM; matches recorded in audit
```

See [../../docs/architecture.md](../../docs/architecture.md) for the redaction policy.
