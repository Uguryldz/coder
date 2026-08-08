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
| Demo dataset (the mock's data, as rows) + seeder | `src/seed-demo.ts` |
| Seed CLI | `src/seed-cli.ts` |
| Pure schema-text parsers (drift guards) | `src/schema-facts.ts` |
| Public surface | `src/index.ts` |

Scripts (`pnpm -F @maestro/db <script>`):

- `postinstall` / `generate` — `prisma generate`. Running it on postinstall is what
  makes `typecheck` work on a cold clone: the generated client lives in
  `node_modules`, so CI (`pnpm install --frozen-lockfile` → `lint`/`typecheck`/`test`)
  needs no extra step. Verified from a wiped `node_modules`.
- `migration:build` — regenerates the initial migration, fully offline:
  `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script --output …`.
- `seed` — `tsx src/seed-cli.ts` (parameters + demo dataset; `--params-only`
  seeds just the parameters). Needs a live database, so the CLI itself is not
  exercised by the offline suite — the data it writes is.
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

## 3b. Seed — demo dataset (`src/seed-demo.ts`)

`insa-plani.md` (Dalga 1) requires the seed to *be* the mock's dataset so that
Studio opens populated, with nothing migrated from v1. `buildDemoDataset()` is
a pure function over a fixed clock (`DEMO_NOW` = the mock's 8 Aug 2026 14:20
Istanbul), so every run produces identical rows.

| Table | Rows | Notes |
| --- | --- | --- |
| `Application` | 5 | ugurpay · ugurweb · ugurmobil-ios · ugurmobil-android · ugurmasaustu, one per platform profile |
| `RepoCard` | 5 | 2–3 modules each (M100 cross-app impact without cloning) |
| `JiraProjectBinding` | 5 | 4 `active` (UGURPAY auto · UGURWEB label · UGURMOB command · UGURDESK auto) + UGURKREDI `draft` (onboarding 3/4) |
| `RoutingRule` | 6 | the mock's tier ① rules; the "component missing" row is deliberately *absent* — no match is what triggers tier ② |
| `WorkflowRun` | 22 | 7 gate · 8 running · 1 queued (quota) · 1 fail (CI red) · 5 done, including the UGURPAY-500 fan-out family and the greenfield UGURPAY-600 |
| `JournalEntry` | 86 | the mock's full 23-entry journal for UGURPAY-501, a 3-entry journal for the rest |
| `StepEvent` | 31 | one "entered step" per run + 9 signed gate decisions |
| `AuditLog` | 15 | a real sha256 chain from `genesis`, seq 81408–81422 (the mock's counter) |
| `LlmCall` | 5 | includes an on-prem `gizli` call and a subscription call with `usd = NULL` (M55) |
| `Variant` / `VariantVersion` | 9 / 9 | the mock's variant table with eval scores |
| `SubscriptionAccount` | 5 | one `exhausted` account with a 100% 5h window |
| `KnowledgeDoc` | 6 | analysis template, BDDK policy, conventions |
| `EvidencePackageRow` | 5 | exactly the closed runs, 10-year retention manifests |
| `User` | 7 | the mock's people and AD groups |

Details worth knowing:

- **Step ids are contract ids.** The mock's numeric steps are indices into its
  STEPS table, which is `STEP_IDS` in the same order, so the mapping is exact
  (`step:16` → `"12"` PR approval, `step:18` → `"13"` closure).
- **Run ids** are `run-<ticket-key-lowercased>`, so any screen can address a run
  without a lookup table.
- **No usable credentials**: every `User.passwordHash` is `"!"`, an
  unmatchable placeholder. A demo install must not ship a working login.
- **`skipDuplicates`** on every insert makes the demo seed re-runnable and
  stops it from overwriting a real installation's rows.
- The audit chain is verified *independently* in the tests (recomputed row by
  row, plus a tamper-detection case).

## 4. Tests

`pnpm -F @maestro/db test` → **6 files, 92 tests, all passing**, offline and
without a database.

| File | Tests | Covers |
| --- | --- | --- |
| `test/schema-enums.test.ts` | 25 | (a) every schema enum mirrors its `@maestro/contracts` enum exactly; no unmapped enum; no `@map` on members; timestamptz / Decimal / Restrict / native-type conventions; unit tests for the parsers themselves |
| `test/migration.test.ts` | 7 | (b) migration SQL exists next to the provider lock, has a `CREATE TABLE` for every model, a `CREATE TYPE` with every value for every enum, 7 `RESTRICT` foreign keys, timestamptz columns, no destructive statements |
| `test/seed.test.ts` | 24 | (c) all 12 definitions validate against `ParamDefinition`; unique contract-shaped keys; `params.description.*` prefix; type/default/enumValues coherence; the guarded set; each default pinned to its M-decision; `seedParams` behaviour against an in-memory fake |
| `test/prisma-validate.test.ts` | 1 | (d) spawns the real Prisma CLI with a placeholder `DATABASE_URL` (`CHECKPOINT_DISABLE=1`, so no network) |
| `test/client.test.ts` | 10 | URL fail-closed validation, no credential leak in errors, lazy client with a delegate for all 17 models |
| `test/seed-demo.test.ts` | 25 | headline counts + status spread; determinism; every row validated against its contract (`MatchResult`, `ApplicationRecord`, `RepoCard`, `RuleCondition`, `JournalEntry`, `GateDecision`, `LlmCallLog`); journal seq contiguity; referential integrity in insert order; audit chain recomputed independently + tamper detection; no usable credential; approver groups match the users table |

Full gate from `maestro/`: `pnpm install` ✔ · `pnpm -F @maestro/db typecheck` ✔ ·
`pnpm -F @maestro/db test` ✔ · `pnpm lint` ✔ (also `pnpm typecheck` + `pnpm test`
across all 5 workspace projects ✔, from a wiped `node_modules`).

## 5. Dependency justifications

| Dependency | Kind | Why |
| --- | --- | --- |
| `@prisma/client@^6.5.0` | dependency | The generated client `createDb` returns. Version range pinned to the same minor family as the `prisma` CLI already in the draft (both resolve to 6.19.3); a mismatch between CLI and client is a known breakage. |
| `@types/node@^24.0.0` | devDependency | `node:fs` / `node:path` / `node:child_process` / `process` in the seed CLI and tests. Same version as `@maestro/test-kit`. |
| `vitest@^3.2.0` | devDependency | The repo's test runner (contracts, config, test-kit already use it). Replaces the placeholder `test` script that only ran `prisma validate` — that check now lives inside the suite. |
| `tsx@^4` | devDependency | Runs the seed CLI (`tsx src/seed-cli.ts`) without a build step. Node 24's native type stripping cannot be used here: the repo's ESM convention is `.js`-extension specifiers pointing at `.ts` files, which Node's resolver does not follow. Dev-only — nothing ships it. |

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
7. **`RoutingRule.projectKey` accepts `"*"` (org-wide rule), but the column is
   a foreign key to `JiraProjectBinding`.** The demo therefore scopes the
   "label = musteri-verisi → human_lead/gizli" rule to a real project instead
   of `*`. Either the schema drops that FK, or a sentinel `*` binding row has
   to exist, or the contract loses `"*"`. Needs a decision before the routing
   service is written.

### 6.2b `packages/audit` (does not exist yet)

M33 says the hash chain has exactly one implementation, in `packages/audit`.
The demo seed needs chained rows *now*, so `src/seed-demo.ts` carries a
deliberately minimal `chainAuditEvents()` (sha256 over
`seq|at|actor|action|subject|prevHash`, first predecessor `"genesis"`). **When
the audit packet lands, the seed must import its chain builder and this helper
must be deleted** — and the audit packet should adopt (or consciously
replace) this canonical payload, because the seeded rows must stay verifiable.

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
5. **Seed CLI runtime** is `tsx`; see the dependency table for why Node's own
   type stripping is not enough. `src/seed.ts` and `src/seed-demo.ts` stay
   pure data + functions, so the suite tests them without touching the CLI.
6. `Param.type` uses a Postgres enum even though `string`/`number`/`enum` look
   like Prisma keywords — verified accepted by `prisma validate` and covered
   by the suite.
7. **Demo data fidelity.** The mock is a static HTML prototype, so a few
   values had to be decided rather than copied:
   - The mock's numeric step is an index into its STEPS list; that list is
     `STEP_IDS` in the same order, so the mapping is mechanical. The
     coordination parent UGURPAY-500 ("koordinasyon") and the greenfield
     UGURPAY-600 ("mimari") have no numeric step and were parked at `"3"`
     (analysis, children fanned out) and `"5"` (architecture approval gate).
   - All 22 runs are `dahili`. The mock only shows a `gizli` data class on an
     LLM call, and that is where the demo puts it — inventing a `gizli` run
     would contradict the routing rules that produce the class.
   - Journals other than UGURPAY-501's are three synthetic entries; the mock
     only ever showed one ticket's journal.
   - `AuditLog.seq` runs 81408–81422 so the newest row is the mock's #81422,
     and the chain starts from `genesis` at 81408 (a demo chain, not a
     continuation of a real one).

## 8. TAKILDIM

None.
