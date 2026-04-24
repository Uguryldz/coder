# ADR-0002: TypeScript Monorepo (Python Reddedildi)

## Status
Accepted — 2026-Q1

## Context
AI/ajan ekosisteminin büyük kısmı Python'da (LangChain, LangGraph, LlamaIndex).
Ancak ürünümüz hem frontend (Next.js + Refine) hem backend (Fastify + Temporal
worker) hem integrasyon (Jira/Bitbucket/Slack SDK) içeriyor; bunların neredeyse
tamamı TypeScript tarafında birinci sınıf. Ekip de TS-dominant. Tek dil, tek
tooling, tek paket yöneticisi gerekiyor.

## Decision
Tüm kod tabanı **TypeScript** olacak ve **pnpm workspace + Turborepo** tabanlı
bir **monorepo** olarak organize edilecek. Python yalnızca geçici betikler
(`scripts/`, opsiyonel) için kullanılabilir; ürün kodunda yer almaz.

## Consequences
- (+) Tek dil → tek build, tek tip sistem, tek lint/test disiplini.
- (+) `packages/contracts` (Zod) API, worker ve UI arasında paylaşılabilir.
- (+) Temporal TS SDK birinci sınıf desteklenir.
- (+) Claude SDK + Anthropic helpers TS tarafında daha stabil.
- (−) LangChain ekosistemini doğrudan kullanamayız; gereken abstraction'ları
  kendimiz `packages/agents` + `packages/llm` altında yazarız.
- (−) Bazı ML / veri araçları TS'de daha zayıf; gerekirse out-of-process
  Python servisi izole edilebilir (şimdilik ihtiyaç yok).

## Alternatives considered
- **Python backend + TS frontend (polyglot)** — iki ayrı CI, iki contract
  formatı, iki rate-limiter. Ekip ve operasyon yükü çok yüksek.
- **Deno / Bun** — ekosistem olgunluğu yetersiz; Temporal SDK + Prisma TS'yi
  varsayıyor.
- **Nx** (Turborepo yerine) — daha ağır; Turborepo cache + pipeline yeterli.

## References
- `plan/projectplan.md` → **K2** (dil seçimi), **K44** (monorepo tooling)
- `pnpm-workspace.yaml`, `turbo.json`
- ADR-0001 (Temporal TS SDK bağımlılığı)
