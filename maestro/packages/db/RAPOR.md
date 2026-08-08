# @maestro/db — packet report (Wave 1)

Scope touched: `maestro/packages/db/**` + `maestro/pnpm-lock.yaml` (own deps only).
`packages/contracts` and `packages/ports` were read, never modified.

## 1. What was built

| Artifact | Path |
| --- | --- |
| Finalized Prisma schema (17 models, 13 enums) | `prisma/schema.prisma` |
| Initial migration, generated offline | `prisma/migrations/0001_init/migration.sql` (332 lines) |
| Migration provider lock | `prisma/migrations/migration_lock.toml` |
| Typed client factory `createDb(url)` | `src/client.ts` |
| 12 default `ParamDefinition`s + idempotent seeder | `src/seed.ts` |
| Pure schema-text parsers (drift guards) | `src/schema-facts.ts` |
| Public surface | `src/index.ts` |

Scripts (`pnpm -F @maestro/db <script>`):

- `postinstall` / `generate` — `prisma generate`. Running it on postinstall is what
  makes `typecheck` work on a cold clone: the generated client lives in
  `node_modules`, so CI (`pnpm install --frozen-lockfile` → `lint`/`typecheck`/`test`)
  needs no extra step. Verified from a wiped `node_modules`.
- `migration:build` — regenerates the initial migration, fully offline:
  `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script --output …`.
- `seed` — `node src/seed.ts` (needs a live database; not exercised by tests).
- `typecheck`, `test`.

### `createDb`

```ts
createDb(url: string, options?: { log?: readonly DbLogLevel[] }): Db  // Db = PrismaClient
```

Validates the URL fail-closed (`assertPostgresUrl`, M6) before constructing the
client and never echoes the URL in the error — it carries the password.
Construction stays lazy, so it is safe in tests and at wiring time. The
package re-exports `Db`; no other package should import `@prisma/client`.

## 2. Schema decisions (draft → final)

Model and enum names were kept 1:1 with the Wave-0 draft. Changes:

1. **`timestamptz(3)` for every `DateTime`** (was Prisma's default naive
   `timestamp(3)`). Contracts carry offset-aware ISO strings and the audit
   chain / 10-year evidence retention (M33/M56) cannot depend on server local
   time. Enforced by a test.
2. **`onDelete: Restrict` on every relation.** Runs, journal entries, params
   and repo cards are retention material (M30/M56); an accidental cascade
   would erase evidence. Nothing in the platform deletes a run today.
3. **`LlmCall.usd` → `Decimal(12, 6)`** (was `Float`). Money is never a float;
   6 decimals covers per-call costs down to micro-dollars. *Callers get
   `Prisma.Decimal` and must `.toNumber()` when mapping to `LlmCallLog.usd`.*
4. **Nine fields promoted from `String` to Postgres enums**, mirroring
   contracts: `JiraProjectBinding.trigger` (`TriggerModeE`), `Param.scope`
   (`ParamScopeE`), `Param.type` (`ParamTypeE`), `JournalEntry.actor/kind`
   (`JournalActorE`/`JournalKindE`), `AuditLog.action` (`AuditActionE`),
   `LlmCall.role` + `Variant.role` (`LlmRoleE`), `SubscriptionAccount.state`
   (`SubscriptionStateE`). Rationale: these value sets are frozen in contracts,
   so the database can reject garbage instead of trusting every writer.
5. **Rule for *not* promoting**: a Prisma enum is only used when every contract
   option is also a legal Prisma identifier, so the generated TS union equals
   the contract union. `StepId` (`"2b"`, `"3o"`), `PlatformProfile`
   (`"linux-node"`), `LlmDriverId`/`SubscriptionDriverId` (`"claude-sub"`)
   would need `@map` aliases, which makes the client's TS value differ from
   the contract value — a silent-mismatch trap for every caller. Those stay
   `VarChar` with contracts as the validator. A test forbids `@map` on enum
   members so this rule cannot erode.
6. **Length caps** (`@db.VarChar`) on identifier-ish columns (ids, keys,
   hashes, step ids). Postgres `text` and `varchar(n)` perform identically;
   the caps exist as a cheap second line of defence behind the zod regexes.
   Free-text columns (`title`, `detail`, `displayName`, `contentRef`) stay
   unbounded `text`.
7. **Indexes added**: `WorkflowRun(updatedAt)` (Studio "recent runs"),
   `AuditLog(subject)` (evidence package collects one ticket's chain),
   `LlmCall(driver, at)` (per-driver cost/quota reporting),
   `SubscriptionAccount(driver, state)` (quota-aware pool picker, M55),
   `EvidencePackageRow(createdAt)` (retention sweeps, M56). Existing draft
   indexes were kept.
8. **Defaults**: `JiraProjectBinding.version @default(1)`.

Deliberately *not* done (kept for the packet that owns the behaviour):
`LlmCall.runId` still has no FK (calls may precede/outlive a run row);
`EvidencePackageRow` has no relation to `WorkflowRun` (would require adding a
back-reference field to a frozen-shaped model); no `@@map` to snake_case table
names (model name = table name keeps the mapping obvious).

## 3. Seed — 12 default parameters (M71)

| Key | Scope | Type | Guarded | Default | Decision |
| --- | --- | --- | --- | --- | --- |
| `gates.risk_tiers` | global | json | ✔ | `GATES_BY_RISK` (2 / 4 / 5 gates + the 2b wait) | M51 |
| `escalation.ladder` | global | json | | 24h jira → 72h teams → 168h smtp | M88 |
| `lang.output` | project | enum | | `tr` (`Locale.options`) | M59 |
| `coverage.ratchet` | application | json | ✔ | `{ allowDecrease: false, minNewLinePct: 80 }` | M70 |
| `sod.qa_split` | global | boolean | ✔ | `false` | M92 |
| `workspace.max_age_days` | global | number | | `60` | M65 |
| `killswitch.state` | global | enum | ✔ | `off` (`off` / `intake_only` / `all`) | M58 |
| `merge.mode` | project | enum | ✔ | `human_merge` | M48 |
| `binding.dry_run_sample_size` | project | number | | `20` | M102 |
| `dataclass.policy` | global | json | ✔ | `gizli → onprem`, fallback `degrade_ai_assist` | M18/M63 |
| `subscription.queue_enabled` | global | boolean | | `true` | M55 |
| `notify.reminder_channel` | global | enum | | `jira` (`NotifyChannel.options`) | M45 |

`seedParams(db, { changedBy?, now? })` is idempotent: definitions are
*upserted* (code owns them, they may gain enum options), version 1 is
*create-only* (`update: {}`) so re-running never walks back an operator's
edit. The clock is injectable, which keeps the tests deterministic.

## 4. Tests

`pnpm -F @maestro/db test` → **5 files, 67 tests, all passing**, offline and
without a database.

| File | Tests | Covers |
| --- | --- | --- |
| `test/schema-enums.test.ts` | 25 | (a) every schema enum mirrors its `@maestro/contracts` enum exactly; no unmapped enum; no `@map` on members; timestamptz / Decimal / Restrict / native-type conventions; unit tests for the parsers themselves |
| `test/migration.test.ts` | 7 | (b) migration SQL exists next to the provider lock, has a `CREATE TABLE` for every model, a `CREATE TYPE` with every value for every enum, 7 `RESTRICT` foreign keys, timestamptz columns, no destructive statements |
| `test/seed.test.ts` | 24 | (c) all 12 definitions validate against `ParamDefinition`; unique contract-shaped keys; `params.description.*` prefix; type/default/enumValues coherence; the guarded set; each default pinned to its M-decision; `seedParams` behaviour against an in-memory fake |
| `test/prisma-validate.test.ts` | 1 | (d) spawns the real Prisma CLI with a placeholder `DATABASE_URL` (`CHECKPOINT_DISABLE=1`, so no network) |
| `test/client.test.ts` | 10 | URL fail-closed validation, no credential leak in errors, lazy client with a delegate for all 17 models |

Full gate from `maestro/`: `pnpm install` ✔ · `pnpm -F @maestro/db typecheck` ✔ ·
`pnpm -F @maestro/db test` ✔ · `pnpm lint` ✔ (also `pnpm typecheck` + `pnpm test`
across all 5 workspace projects ✔, from a wiped `node_modules`).

## 5. Dependency justifications

| Dependency | Kind | Why |
| --- | --- | --- |
| `@prisma/client@^6.5.0` | dependency | The generated client `createDb` returns. Version range pinned to the same minor family as the `prisma` CLI already in the draft (both resolve to 6.19.3); a mismatch between CLI and client is a known breakage. |
| `@types/node@^24.0.0` | devDependency | `node:fs` / `node:path` / `node:child_process` / `process` in the seed CLI and tests. Same version as `@maestro/test-kit`. |
| `vitest@^3.2.0` | devDependency | The repo's test runner (contracts, config, test-kit already use it). Replaces the placeholder `test` script that only ran `prisma validate` — that check now lives inside the suite. |

No other dependency was added. `prisma` and `typescript` were already declared
by the Wave-0 draft.

## 6. REQUESTS (nothing was changed outside this package)

### 6.1 `packages/config` message catalog — 9 missing keys

`params.description.gate_set`, `params.description.escalation_ladder` and
`params.description.output_language` already exist in `locales/{tr,en}.json`.
The seed needs nine more (TR / EN suggestions):

| Key | tr | en |
| --- | --- | --- |
| `params.description.coverage_ratchet` | "Kapsam mandalı: düşüş yasak, yeni satırlarda alt sınır" | "Coverage ratchet: no decrease, floor for new lines" |
| `params.description.sod_qa_split` | "QA görev ayrılığı: senaryo onaylayan ≠ sonuç onaylayan" | "QA separation of duties: scenario approver ≠ result approver" |
| `params.description.workspace_max_age_days` | "Hareketsiz workspace'in arşivlenme süresi (gün)" | "Idle workspace archive age (days)" |
| `params.description.kill_switch_state` | "Kill-switch durumu: kapalı / yalnız yeni iş durdu / her şey durdu" | "Kill switch state: off / intake stopped / everything stopped" |
| `params.description.merge_mode` | "Merge modu: insan-merge veya auto-merge" | "Merge mode: human merge or auto merge" |
| `params.description.dry_run_sample_size` | "Aktivasyon öncesi kuru koşumda incelenen ticket sayısı" | "Ticket count sampled by the pre-activation dry run" |
| `params.description.data_class_policy` | "Veri sınıfı → LLM arka ucu eşlemesi ve on-prem yoksa davranış" | "Data class → LLM backend mapping and the no-on-prem fallback" |
| `params.description.subscription_queue` | "Abonelik havuzu tükendiğinde işi kuyruğa al" | "Queue the run when the subscription pool is exhausted" |
| `params.description.reminder_channel` | "İlk hatırlatıcının gönderileceği kanal" | "Channel used for the first reminder" |

`test/seed.test.ts` only asserts the `params.description.` prefix, so the
suite stays green until the catalog packet lands; a catalog-parity test on the
`config` side should then cover the nine keys.

### 6.2 `packages/contracts` (frozen — wishes only)

1. **`ParamChange.scopeRef` is `string | null`, but the database column is part
   of the `ParamVersion` primary key**, and Postgres does not allow NULL in a
   PK. The DB therefore uses `""` for "no scope ref" (`GLOBAL_SCOPE_REF`), and
   whoever writes the params service must map `null ↔ ""`. Cleaner: make the
   contract `.default("")` instead of nullable, or the DB gain a surrogate key.
2. **No `KillSwitchState` enum.** `KillSwitchSignal.level` is
   `intake_only | all`, but the *stored parameter* also needs the resting
   state, so the seed declares `off | intake_only | all` inline. Please add
   `KillSwitchState = z.enum(["off", "intake_only", "all"])` and derive the
   signal level from it.
3. **No `MergeMode` enum** for M48; the seed declares
   `human_merge | auto_merge` inline. A contract enum would let the DB use a
   Postgres enum here too.
4. **No value schemas for json-typed parameters.** `ParamDefinition.defaultValue`
   is `unknown`, so nothing validates `gates.risk_tiers`,
   `escalation.ladder`, `coverage.ratchet` or `dataclass.policy` when an admin
   edits them in Studio. Suggestion: add `ParamValueSchemas` (a registry keyed
   by `ParamKey`) or a `valueSchemaName` field on `ParamDefinition`, so the
   params service can validate fail-closed the same way analyses are validated.
5. **`LlmCallLog.usd` is `number`; the column is `Decimal`.** The llm-gateway
   packet needs a documented conversion point (`.toNumber()` on read).
6. **`RiskTier`-keyed gate sets are duplicated** between `GATES_BY_RISK`
   (code constant) and the `gates.risk_tiers` parameter (runtime value). The
   seed test pins them to each other; the workflow packet must decide which one
   is authoritative at run time (proposal: the parameter, with the constant as
   the seed value only).

### 6.3 Root `package.json` (out of scope for this packet)

`pnpm install` prints `Ignored build scripts: @prisma/client@6.19.3`. That
script is `prisma generate` without a schema — harmless, since this package
runs `prisma generate --schema prisma/schema.prisma` in its own `postinstall`.
To silence the warning, add `"@prisma/client"` to `pnpm.onlyBuiltDependencies`
in the root `package.json`.

## 7. Assumptions

1. **Parameter key style.** `ParamKey` is `^[a-z][a-z0-9_.]+$`, so the mock's
   camelCase keys (`gates.riskTiers`, `workspace.maxAgeDays`) are illegal.
   Keys were transliterated to snake_case, keeping the mock's namespaces.
   `binding.dry_run_sample_size` is a new namespace (the mock screen showed
   the dry-run size on the routing screen, not the parameters screen).
2. **Mock scope "repo" → contract scope `application`**, and "platform" is not
   a `ParamScope`; the platform-specific build timeouts from the mock are not
   part of this packet's 12.
3. **Guarded flags** follow "does it weaken a control?": gate sets, coverage
   ratchet, QA SoD, kill switch, merge mode and the data-class policy are
   four-eyes; ladders, language, sample size, workspace age, queueing and
   reminder channel are not.
4. **Migration directory name** is `0001_init` as specified, not Prisma's
   `<timestamp>_init` convention. Prisma applies migrations in lexicographic
   order, so follow-ups must continue `0002_…`, `0003_…`.
5. **Seed CLI runtime.** `src/seed.ts` imports only package specifiers and
   node builtins (no relative `./x.js` imports), so `node src/seed.ts` works
   through Node 24's native type stripping without adding a TS runner
   dependency. The trade-off is a small duplication: the CLI constructs
   `PrismaClient` itself instead of calling `createDb`.
6. `Param.type` uses a Postgres enum even though `string`/`number`/`enum` look
   like Prisma keywords — verified accepted by `prisma validate` and covered
   by the suite.

## 8. TAKILDIM

None.
