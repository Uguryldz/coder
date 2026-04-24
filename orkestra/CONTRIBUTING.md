# Katkı Rehberi / Contributing Guide

Bu doküman Jira AI Orkestra üzerinde çalışan geliştiriciler için yerel geliştirme,
dal ve commit disiplini, PR akışı ve yaygın operasyonları tanımlar. Ürün özel ticari
bir üründür; dış katkılar yalnızca ticari sözleşme kapsamındaki ekiplerden kabul
edilir.

## Ön Koşullar / Prerequisites

| Araç | Sürüm | Not |
|------|-------|-----|
| Node.js | 22 LTS | `.nvmrc` içinde sabitlenmiştir |
| pnpm | 10.x | `corepack enable` ile etkinleştir |
| Docker | 24+ | Docker Compose v2 |
| Git | 2.40+ | - |

Opsiyonel: Temporal CLI (`tctl`), `jq`, `direnv`.

## İlk Kurulum / Initial Setup

```bash
# 1. Depoyu klonla
git clone <repo-url> orkestra && cd orkestra

# 2. Node sürümünü sabitle
nvm use   # veya asdf install

# 3. Bağımlılıkları kur (pnpm workspace otomatik linkler)
pnpm install

# 4. Prisma client generate
pnpm --filter @orkestra/db generate

# 5. Altyapıyı ayağa kaldır (Postgres, Temporal, MinIO, Redis)
pnpm docker:up

# 6. DB migrate + seed
pnpm --filter @orkestra/db migrate
pnpm --filter @orkestra/db seed

# 7. Dev modda tüm uygulamalar
pnpm dev
```

## Dallanma Stratejisi / Branching

- `main` — her zaman yeşil, deploy edilebilir.
- `feature/JIRA-XXX-kisa-aciklama` — her PR mutlaka bir Jira ticket'ına bağlanır.
- `hotfix/JIRA-XXX-aciklama` — üretim fix'leri; `main`'den çıkar, `main` ve açık
  `release/*` dalına cherry-pick edilir.
- `release/vX.Y` — uzun süreli destek gereken sürümler için (opsiyonel).

### AI üretimli commit'ler
Ajan veya Copilot tarafından tamamen üretilen commit'lerin öneki `[AI]` olmalıdır.
Örn. `[AI] feat(workflows): add retry policy for sandbox step`.
4-göz prensibi gereği `[AI]` commit'lerini **yazar olmayan** bir reviewer onaylar.

## Commit Mesaj Formatı / Conventional Commits

`commitlint.config.mjs` içindeki kurallarla zorlanır. Tip listesi:

`feat` · `fix` · `chore` · `docs` · `refactor` · `test` · `build` · `ci` · `perf` · `style`

```
<tip>(<scope>): <kısa özet, 72 kr altı, emir kipi>

<opsiyonel gövde - ne/neden>

Refs: JIRA-123
```

Örnekler:
- `feat(agents): add senior-backend variant resolver`
- `fix(sandbox): increase memory limit for java projects`
- `[AI] refactor(llm): extract rate limiter to dedicated class`

## PR Checklist

PR açmadan önce aşağıdakilerin tümünün doğru olduğundan emin ol:

- [ ] `pnpm typecheck` yeşil
- [ ] `pnpm lint` yeşil
- [ ] `pnpm test` (unit + integration) yeşil
- [ ] Yeni davranış için test eklendi (TDD tercih edilir)
- [ ] Public API / contract değişti ise `packages/contracts` güncel
- [ ] Etkilenen dokümantasyon güncellendi (`docs/*`, ADR gerekiyorsa `docs/adr/`)
- [ ] `plan/projectplan.md` içindeki bir karar etkileniyorsa PR açıklamasında
      ilgili `K##` numarası referans verildi
- [ ] PR açıklamasında Jira ticket linki var
- [ ] Workflow / policy / güvenlik etkileyen değişiklikte 4-göz: analiz eden kişi
      değil ikinci bir reviewer onayı

## Testleri Çalıştırma / Running Tests

```bash
# Tüm unit testler
pnpm test

# Tek paket
pnpm --filter @orkestra/workflows test

# Integration (docker bağımlı)
pnpm test:integration

# Smoke (uçtan uca minimal)
pnpm smoke-test

# Tek dosya
pnpm --filter @orkestra/agents test -- src/variant/resolve.test.ts
```

## Plan Değişikliği Önerme / Proposing a Plan Change

`plan/projectplan.md` 49 mimari karar (K1–K49) içerir. Bir kararı değiştirmek
istiyorsan:

1. Yeni bir dal aç: `feature/JIRA-XXX-plan-KNN-update`
2. `plan/projectplan.md` içinde ilgili karara "Proposed Change" bloğu ekle; eski
   metni silme, üstünü çiz.
3. Uygun ise `docs/adr/NNNN-*.md` altında yeni bir ADR ekle (mevcut ADR'ı
   `Status: Superseded by ADR-NNNN` olarak işaretle).
4. PR açıklamasında gerekçe + etki analizini yaz; teknik lead + ürün onayı şart.

## Yeni AI Ajan Variant'ı Ekleme / Adding a New Agent Variant

Çalışma zamanı (runtime) tarafı için bkz. `docs/developer-guide.md`. Operatör
(Agent Studio UI) tarafı için:

1. Studio > Agents > ilgili ajan tipi > "New Variant".
2. Knowledge Pack seç (veya yeni bir pack oluştur; bkz. `docs/agent-studio.md`).
3. Prompt template + model + sıcaklık + rate-limit ayarla.
4. Routing Rule ekle: hangi proje / etiket / priority kombinasyonunda bu variant
   kullanılsın.
5. Shadow mode'da en az 5 ticket çalıştır, çıktı karşılaştır; yeşilse promote et.
6. İlgili kararı `plan/projectplan.md` içindeki K13 (knowledge) / K43
   (variant catalog) ile hizala.

## Yardım / Help

- Ekip içi: `#orkestra-dev` Slack kanalı
- Sorun / bug: Jira `ORK` projesi
- Güvenlik: bkz. [SECURITY.md](./SECURITY.md)
