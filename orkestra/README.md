# Jira AI Orkestra

Ticari, on-prem, dockerize edilmiş, Jira-yönetimli AI çalışan platformu.
7 AI ajan + 6 insan onay kapısı + 4 work mode ile ticket'ı PR'a kadar götürür.

- **Single-tenant** — her müşteri kendi stack'ini çalıştırır.
- **Tek dış çıkış** — Claude API (mock modda o bile yok).
- **Dockerize** — `docker compose up`.

## Hızlı Başlangıç

```bash
# 1. Bağımlılıkları kur
pnpm install

# 2. İnteraktif kurulum (Jira, Bitbucket, Claude, Slack ayarları)
pnpm exec node scripts/install-wizard.mjs

# 3. Servisleri ayağa kaldır
pnpm docker:up

# 4. DB migration + seed (ilk kurulumda)
pnpm --filter @orkestra/db generate
pnpm --filter @orkestra/db migrate
pnpm --filter @orkestra/db seed

# 5. Smoke test
pnpm smoke-test
```

## Arayüzler
- **Agent Studio** (admin): http://localhost:3001
- **Temporal UI** (workflow izleme): http://localhost:8233
- **MinIO Console** (artefakt depolama): http://localhost:9001
- **API** (webhook + REST): http://localhost:3000

## Geliştirme
```bash
pnpm dev            # tüm paketler
pnpm test           # unit + integration
pnpm typecheck      # TS typecheck
pnpm lint           # eslint
pnpm docker:logs    # servis log'ları
```

## Mimari
- `apps/api` — Fastify webhook receiver + REST (Refine data provider)
- `apps/worker` — Temporal worker host (workflow + activities)
- `apps/studio` — Next.js + Refine admin UI
- `packages/workflows` — Temporal workflow ve activity tanımları (15 adım)
- `packages/agents` — ajan runtime (variant resolve, knowledge pack, PII)
- `packages/jira`, `packages/git`, `packages/slack`, `packages/testrail` — entegrasyonlar
- `packages/sandbox` — ephemeral Docker runtime + güvenlik taraması
- `packages/pii` — alan + regex bazlı PII maskeleme
- `packages/audit` — hash-chain'li audit log
- `packages/llm` — Claude SDK + mock + rate limiter + prompt caching
- `packages/db` — Prisma schema + client
- `packages/contracts` — Zod I/O şemaları
- `packages/config` — env + logger

## Dokümantasyon
- `docs/install.md` — Ayrıntılı kurulum ve ağ konfigürasyonu
- `docs/runbook.md` — Production operasyon: scale, backup, upgrade, troubleshoot
- `docs/architecture.md` — Karar kayıtları, veri akışı, güvenlik modeli
- `docs/agent-studio.md` — Variant + Knowledge Pack yönetimi
- `docs/workflow.md` — 15 adım ve work mode'lar
- `docs/integrations.md` — Jira, Bitbucket, Slack, TestRail konfigürasyonu

## Lisans
Özel ticari ürün. Ayrıntı: [LICENSE](./LICENSE).

## Yönetişim ve Katkı / Governance

- [LICENSE](./LICENSE) — Tescilli lisans şartları (TR özet + EN tam metin)
- [CONTRIBUTING.md](./CONTRIBUTING.md) — Geliştirme akışı, dal + commit disiplini, PR checklist
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) — Davranış kuralları
- [SECURITY.md](./SECURITY.md) — Zafiyet bildirimi, SLA, kapsam
- [CHANGELOG.md](./CHANGELOG.md) — Sürüm notları (Keep a Changelog)
- [docs/adr/](./docs/adr/) — Mimari kararlar (Temporal, TS monorepo, sandbox, knowledge pack, single-tenant)
- [docs/developer-guide.md](./docs/developer-guide.md) — Yeni geliştirici onboarding rehberi
- [docs/ops-cheatsheet.md](./docs/ops-cheatsheet.md) — Operasyon hızlı referansı
- [.github/CODEOWNERS](./.github/CODEOWNERS) — Reviewer atamaları
