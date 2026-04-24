# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Commit mesajları için bkz. [CONTRIBUTING.md](./CONTRIBUTING.md#commit-mesaj-formatı--conventional-commits).

## [Unreleased]

### Added
- _placeholder — eklenen yeni özellikleri buraya yazın_

### Changed
- _placeholder — mevcut davranıştaki değişiklikleri buraya yazın_

### Deprecated
- _placeholder — gelecekte kaldırılacak API / konfigürasyon_

### Removed
- _placeholder — kaldırılan özellik / API_

### Fixed
- _placeholder — hata düzeltmeleri_

### Security
- _placeholder — güvenlik düzeltmeleri (CVE / iç referans)_

---

## [0.1.0] — 2026-04-21

İlk MVP sürümü. Tek-tenant, on-prem, dockerize Jira AI Orkestra'nın üretim-okur
minimum özellik setini içerir.

### Added
- **Workflow engine** — Temporal tabanlı 15 adımlı ticket → PR workflow'u
  (`packages/workflows`), 4 work mode: shadow, assist, propose, autonomous
- **7 AI ajan tipi** (`packages/agents`): analyst, planner, implementer, reviewer,
  tester, doc-writer, pm-assistant — her biri variant + knowledge pack destekli
- **Knowledge Pack sistemi** — variant başına enjekte edilen, versiyonlu,
  RAG-desteksiz compact bilgi dosyaları (K13 / K43 kararları)
- **Agent Studio** (`apps/studio`) — Next.js + Refine admin UI, variant/route
  yönetimi, knowledge pack editörü, shadow compare görünümü
- **Ephemeral Docker sandbox** (`packages/sandbox`) — no-network default, per-run
  tear-down, kaynak limitleri (K8)
- **PII maskeleme pipeline'ı** (`packages/pii`) — alan + regex hybrid, LLM'e
  gitmeden önce uygulanır
- **Hash-chain'li audit log** (`packages/audit`) — immutable, zincir doğrulama
  CLI ile
- **Jira entegrasyonu** — webhook receiver (`apps/api`), issue read/comment/transition
- **Bitbucket Git entegrasyonu** (`packages/git`) — clone, branch, commit, PR
- **Slack entegrasyonu** (`packages/slack`) — onay kapıları + bildirimler
- **TestRail entegrasyonu** (`packages/testrail`) — test case sync
- **LLM adapter** (`packages/llm`) — Claude SDK + mock mode + rate limiter +
  prompt caching
- **Prisma DB schema** (`packages/db`) — ticket, run, step, variant, knowledge
  pack, audit kayıtları
- **Zod I/O contracts** (`packages/contracts`) — tüm servisler arası şemalar
- **İnteraktif install wizard** (`scripts/install-wizard.mjs`)
- **Runbook + mimari + install + workflow dokümantasyonu** (`docs/`)

### Security
- Single-tenant deployment modeli (K9) — paylaşımlı fiziksel DB yok
- Tek dış çıkış: Claude API; mock modda sıfır dış çağrı
- Sandbox default no-network; explicit allowlist gerekir
- `.env` repo'ya commit edilmez; `.env.example` şablon

### Known Limitations
- `orkestra-diag` destek paketleme aracı henüz yok
- Multi-region deployment desteklenmiyor
- Agent Studio'da i18n yalnızca TR; EN sonraki sürümde
- Bazı ajan variant'ları shadow-only modda başlıyor; promote manuel

[Unreleased]: <internal-repo>/compare/v0.1.0...HEAD
[0.1.0]: <internal-repo>/releases/tag/v0.1.0
