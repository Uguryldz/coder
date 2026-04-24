# Mimari

## Üst Seviye

![System](../plan/diagrams/system.png)

- **Jira DC** → webhook → **API** → **Temporal** → **Worker Pool**
- **Worker Pool** → **Claude API** (tek dış çıkış) + **Dev Sandbox** (Docker-in-Docker)
- **Sandbox** → **Bitbucket** → **Pipelines** → CI Gate signal → Workflow
- **Agent Studio** (Next.js + Refine) → **API** → **Postgres**

Tüm veri katmanı (Postgres, Redis, MinIO, Vault) müşteri ağında.

## Workflow

15 adımlık Temporal workflow (`TicketLifecycleWorkflow`). Detaylar [`workflow.md`](./workflow.md).

## Kararlar (K1 — K49)

Tam karar kaydı [`../plan/projectplan.md`](../plan/projectplan.md).

Öne çıkanlar:

| # | Karar |
|---|-------|
| K1 | Temporal (self-hosted) workflow engine |
| K2 | TypeScript monorepo (pnpm + Turborepo) |
| K3 | PostgreSQL tek RDBMS |
| K8 | Ephemeral Docker sandbox (E2B değil) |
| K9 | Single-tenant deployment |
| K13 | Knowledge Pack per variant + shared library |
| K14 | Prompt caching zorunlu |
| K15 | Structured output (Zod) her yerde |
| K16 | Hash-chain'li audit log |
| K17 | Per-workflow cost budget (arka planda) |
| K25 | Bitbucket Pipelines CI gate |
| K32 | `.orkestra.yaml` repo-level config |
| K40 | PII masking layer (LLM çağrısı öncesi) |
| K43 | Agent Studio = Refine + shadcn + Tiptap + Monaco |

## Paket Haritası

```
apps/
├── api         Fastify webhook + REST (Refine data provider)
├── worker      Temporal worker host
└── studio      Next.js + Refine + shadcn admin UI

packages/
├── contracts   Zod schemas (inter-agent contracts)
├── config      env loader + Pino logger
├── db          Prisma schema + client + seed
├── audit       Hash-chain append-only audit
├── pii         Field + regex PII masking
├── llm         Claude SDK + mock + rate limiter + prompt caching
├── agents      Variant resolve + knowledge pack runtime
├── workflows   Temporal workflow + activities + signals
├── jira        Jira DC client + webhook + ADF + commands
├── git         Bitbucket + GitHub/GitLab stubs + branch protection
├── sandbox     Docker-in-Docker runtime + scans + capacity pool
├── slack       Critical + digest notifications
├── testrail    TestRail + Xray stub
└── ui          (reserved for shared components)
```

## Veri Akışı

### Yeni Ticket
1. Jira webhook → API `/webhooks/jira`
2. HMAC doğrulama → `startWorkflow`
3. Temporal persist
4. Worker pool'dan bir worker pickup
5. Activity: `fetchJiraTicket`, `createWorkflowRun` (DB insert), `transitionJiraStatus`
6. Agent çağrıları (PII mask → Claude → Zod parse → DB persist → MinIO store)
7. İnsan kapılarında `condition(signal)` bekler

### Yorum Komutu
1. Jira webhook → API `/webhooks/jira`
2. `parseJiraCommand` (slash + args)
3. Yetki kontrolü (yetkisiz → silent drop)
4. Temporal `signal` dispatch
5. Workflow'un `setHandler` callback'i state güncelliyor
6. Workflow main loop ilerliyor

### AI Agent Çağrısı
1. `resolveVariant(role, ticket)` → routing rules
2. `loadKnowledgePack(variantId)` → DB + MinIO paralel fetch
3. `compileSystemPrompt(systemPrompt, pack)` → cacheable blocks
4. PII masking → Claude
5. Structured output → Zod parse
6. Retry (max 1) on schema violation
7. Token/cost tracking → DB
8. Audit log append

## Güvenlik Modeli

| Tehdit | Önlem |
|--------|-------|
| Developer AI zararlı kod | Ephemeral sandbox + scans + branch pattern + patch review |
| Prompt injection | Structured output + system prompt hardening + tool allowlist |
| Secret sızıntısı | Vault runtime inject + Pino redact |
| 4-göz ihlali | Hard check in workflow + audit violation |
| Replay / tamper | Webhook HMAC + audit hash chain |
| DoS cost | Rate limit + budget cap + circuit breaker |
| PII dışa çıkışı | Field + pattern masking + reverse map |
| Sandbox escape | Non-root + seccomp + read-only rootfs + network-deny |

## Ölçek

- **Stateless worker** — role bazlı task queue, independent HPA
- **Durable workflow** — Temporal event history persistence
- **Prompt cache** — %90 maliyet düşüşü (500 ticket/gün × 7 ajan: $1000 → $100)
- **Sandbox capacity pool** — max concurrent (default CPU/4), queue bekler
- **Backpressure** — Claude/Bitbucket rate limit → Jira "queued" yorumu

## Atlassian Marketplace Uyumu (Gelecek)

Kararların tamamı marketplace app olarak paketlemeye hazır:
- Single-tenant deployment → app install per-instance
- REST-first API → Forge / Connect adaptasyonu
- Jira custom field konfigürasyonu → native look & feel
- OAuth-ready auth (K19) → marketplace OAuth
