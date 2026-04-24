# Geliştirici Rehberi / Developer Guide

Jira AI Orkestra'ya yeni katılan bir geliştirici için "nereden başlarım"
rehberi. Operatör / müşteri dokümanları için `docs/install.md`, `docs/runbook.md`
ve `docs/agent-studio.md` dosyalarına bakın.

## Repo Turu / Repo Tour

```
orkestra/
├── apps/
│   ├── api/         Fastify webhook receiver + REST (Refine data provider)
│   ├── worker/      Temporal worker host — tüm workflow + activity burada koşar
│   └── studio/      Next.js + Refine admin UI (Agent Studio)
├── packages/
│   ├── workflows/   Temporal workflow ve activity tanımları (15 adım)
│   ├── agents/      Ajan runtime, variant resolver, knowledge pack
│   ├── sandbox/     Ephemeral Docker sandbox runtime
│   ├── llm/         Claude SDK + mock + rate limiter + prompt cache
│   ├── jira/        Jira REST client + webhook parser
│   ├── git/         Bitbucket/Git client (clone, branch, PR)
│   ├── slack/       Slack API wrapper + approval gate helpers
│   ├── testrail/    TestRail sync
│   ├── pii/         PII maskeleme pipeline (alan + regex)
│   ├── audit/       Hash-chain audit log
│   ├── db/          Prisma schema + client
│   ├── contracts/   Zod I/O şemaları
│   └── config/      env + logger (Pino)
├── deploy/          docker-compose + helm chart
├── scripts/         kurulum wizard, migration, smoke-test betikleri
├── tests/           integration ve smoke testler
├── docs/            kullanıcı dokümantasyonu
├── plan/            projectplan.md (49 karar) — tek gerçek kaynak
└── .github/         CODEOWNERS, workflows
```

### "Önce şu dosyaları okuyun" / Onboarding Checklist

1. [ ] `README.md` — 5 dakikalık ürün bakışı
2. [ ] `plan/projectplan.md` — 49 karar (K1–K49); ürünün niye böyle olduğu
3. [ ] `docs/architecture.md` — veri akışı + bileşen haritası
4. [ ] `docs/workflow.md` — 15 adım ve work mode'lar
5. [ ] `docs/adr/` — süperse edilmiş kararlar dahil tüm ADR'lar
6. [ ] `packages/contracts/src/` — sistemdeki tipleri buradan öğrenirsin
7. [ ] `packages/workflows/src/workflow.ts` — 15 adımın iskeleti
8. [ ] `packages/agents/src/variant/` — variant resolver akışı
9. [ ] `CONTRIBUTING.md` — commit / PR disiplini

## Yerel Geliştirme / Local Dev

```bash
nvm use
pnpm install
pnpm --filter @orkestra/db generate
pnpm docker:up
pnpm --filter @orkestra/db migrate
pnpm --filter @orkestra/db seed
pnpm dev
```

### Docker olmadan (minimal subset)

Tam akış Docker gerektirir ama contract + unit test geliştirmek için minimum:

```bash
# Sadece Postgres lazım
docker run -d --name orkestra-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=orkestra postgres:16

export DATABASE_URL="postgresql://postgres:orkestra@localhost:5432/postgres"
pnpm --filter @orkestra/db generate
pnpm --filter @orkestra/db migrate

# Contract / util paketleri Docker-bağımsız
pnpm --filter @orkestra/contracts test
pnpm --filter @orkestra/pii test
pnpm --filter @orkestra/agents test
```

`apps/worker` ve `apps/api` Temporal + MinIO + Redis gerektirir; tamamen yerel
koşmak istiyorsanız `pnpm docker:up` en pratiği.

## Yeni Paket Ekleme / Adding a New Package

```bash
# 1. Klasörü oluştur
mkdir -p packages/my-thing/src

# 2. package.json (workspace deps pnpm ile: "workspace:*")
cat > packages/my-thing/package.json <<'JSON'
{
  "name": "@orkestra/my-thing",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@orkestra/config": "workspace:*",
    "@orkestra/contracts": "workspace:*"
  }
}
JSON

# 3. tsconfig.json — tsconfig.base.json'a extend
cat > packages/my-thing/tsconfig.json <<'JSON'
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "composite": true
  },
  "include": ["src/**/*"]
}
JSON

# 4. Entry point
echo 'export const hello = () => "hi";' > packages/my-thing/src/index.ts

# 5. Kısa README
echo '# @orkestra/my-thing' > packages/my-thing/README.md

# 6. Lock dosyasını ve turbo cache'i güncelle
pnpm install
pnpm --filter @orkestra/my-thing build
```

Not: `turbo.json` ve `pnpm-workspace.yaml` başka bir subagent tarafından
sahiplenilen dosyalar — değişiklik gerekiyorsa o ekiple koordine edin.

## Yeni Workflow Adımı Ekleme / Adding a Workflow Step

1. **Contract'ı tanımla** — `packages/contracts/src/workflow/stepName.ts`
   içine Zod input/output şeması.
2. **Activity'yi yaz** — `packages/workflows/src/activities/stepName.ts`.
   Side-effect'ler (HTTP, DB, dosya) mutlaka activity içinde.
3. **Workflow'a bağla** — `packages/workflows/src/workflow.ts` içinde
   `proxyActivities` ile import, uygun yerde `await` ederek adımı ekle.
4. **Retry / timeout politikası** — activity seçenekleri workflow'da
   tanımlanmalı; keyfi default bırakma.
5. **Audit kaydı** — `@orkestra/audit` üzerinden step in/out event'leri.
6. **Test** — activity için unit, workflow için `TestWorkflowEnvironment`.
7. **Dokümante et** — `docs/workflow.md`'deki adım tablosuna ekle, gerekirse
   `plan/projectplan.md`'ye `K##` referanslı karar notu.

## Yeni Ajan Variant'ı (Runtime) / Adding an Agent Variant

Studio UI tarafı için `CONTRIBUTING.md`'ye bakın. Runtime (kod) tarafı:

1. `packages/agents/src/variants/<agent-type>/` altında variant modülü oluştur.
2. `resolve()` fonksiyonu routing context'i alıp `VariantConfig` dönmeli.
3. Prompt template'i `packages/agents/src/prompts/<agent-type>/<variant>.md`
   içinde tutulmalı (tek gerçek kaynak).
4. Knowledge Pack reference'ı `variant.knowledgePackId` ile seed'den gelir.
5. `packages/agents/src/registry.ts` içine kaydet.
6. Shadow mode default; production routing PR'ı ürün lead + teknik lead ortak
   onayı ile açılır.

## Debugging

### Log yapısı (Pino)
Tüm servisler structured JSON log üretir. Her satırda:

- `level`, `time`, `msg`
- `runId` — Temporal workflow run id
- `ticketId` — Jira ticket id
- `corrId` — correlation id (webhook → workflow boyunca taşınır)
- `agent` / `variant` / `step` — ajan adımlarında

```bash
pnpm docker:logs | grep '"runId":"<RUN_ID>"'
pnpm docker:logs | jq 'select(.corrId=="<CORR_ID>")'
```

### Correlation ID
Webhook receiver her istek için ULID üretir ve workflow'a input olarak geçer.
Bir ticket'ın tüm yolculuğunu izlemek için `corrId` yeterli.

### Temporal UI ipuçları
- http://localhost:8233 — workflow listesi
- Workflow detayında "History" → her activity çağrısını ve payload'ını görürsün
- "Stack trace" sekmesi askıda kalan workflow'un hangi `await`'te durduğunu gösterir
- "Pending activities" > "Last Failure" retry sebebini verir

## Yaygın Tuzaklar / Common Pitfalls

- **Prisma generate unutmak** — schema değişince `pnpm --filter @orkestra/db generate` çalıştırmadan TS hataları alırsın.
- **ESM vs CJS** — repo full ESM (`"type": "module"`). `require` yok; dynamic import gerekirse `await import()`.
- **pnpm filter syntax** — virgül değil, `--filter` birden fazla kez:
  `pnpm --filter @orkestra/agents --filter @orkestra/workflows test`.
- **Workflow determinism** — workflow kodunda `Date.now()`, `Math.random()`,
  `fs`, `http` YASAK; activity'ye taşı. Aksi halde replay'de crash.
- **`[AI]` commit etiketi** — AI tarafından üretilen PR'lar için mutlaka.
- **Secret sızıntısı** — `.env` ve `deploy/secrets/` commit etme; pre-commit hook
  uyarır ama dikkat et.
- **Prompt cache breakage** — knowledge pack versiyonu değişince cache düşer;
  küçük stylistic edit'ler için bile minor bump planla.
