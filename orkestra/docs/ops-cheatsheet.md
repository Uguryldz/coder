# Ops Cheatsheet / Operasyon Hızlı Başvuru

Tek sayfalık hızlı referans. Tam operasyon rehberi için bkz. [`runbook.md`](./runbook.md).

## Docker Compose

```bash
pnpm docker:up                      # Tüm stack
pnpm docker:down                    # Temiz kapat
pnpm docker:logs                    # Tüm servislerin logu (follow)
docker compose restart api          # Tek servis restart
docker compose ps                   # Servis sağlık durumu
docker compose exec postgres psql -U postgres
docker compose exec api sh          # API container'ına gir
```

## Loglar / Log Arama

```bash
# Bir ticket'ın tüm yolculuğu
pnpm docker:logs | jq -r 'select(.ticketId=="ORK-123")'

# Belirli bir run
pnpm docker:logs | jq 'select(.runId=="01HN...XYZ")'

# Correlation ID ile uçtan uca
pnpm docker:logs | jq 'select(.corrId=="abc-def")'

# Sadece error seviyesi
pnpm docker:logs | jq 'select(.level>=50)'

# Belirli ajan + variant
pnpm docker:logs | jq 'select(.agent=="implementer" and .variant=="senior-backend")'
```

## Audit Chain

```bash
# Son 100 kayıt
pnpm --filter @orkestra/audit cli -- tail -n 100

# Zincir bütünlüğünü doğrula
pnpm --filter @orkestra/audit cli -- verify

# Belirli ticket için audit trail
pnpm --filter @orkestra/audit cli -- show --ticket ORK-123

# Dışa aktar (PII maskeli, destek talebi için güvenli)
pnpm --filter @orkestra/audit cli -- export --ticket ORK-123 --redact
```

## Temporal / Workflow

```bash
# Temporal UI
open http://localhost:8233

# Workflow'ları listele
docker compose exec temporal tctl workflow list

# Workflow detayını göster
docker compose exec temporal tctl workflow show -w <workflowId>

# Workflow'u manuel iptal et
docker compose exec temporal tctl workflow cancel -w <workflowId>

# Daha agresif: terminate (geri dönülmez)
docker compose exec temporal tctl workflow terminate -w <workflowId> --reason "stuck, manual review"

# Signal gönder (ör. onay kapısı manuel tetikleme)
docker compose exec temporal tctl workflow signal -w <workflowId> -n approveGate -i '{"gate":"review","by":"ops"}'
```

## Database

```bash
# Migration uygula
pnpm --filter @orkestra/db migrate

# Studio (Prisma) ile veri inceleme
pnpm --filter @orkestra/db studio

# Yedek al (runbook'taki tam prosedürü tercih edin)
docker compose exec postgres pg_dump -U postgres orkestra > backup-$(date +%F).sql
```

## Sağlık / Healthcheck

```bash
curl -s http://localhost:3000/health | jq     # API
curl -s http://localhost:3001/api/health      # Studio
curl -s http://localhost:7233/api/v1/namespaces  # Temporal
curl -s http://localhost:9000/minio/health/live  # MinIO
```

## Yaygın Sorunlar / Troubleshooting

| Belirti | Olası Neden | İlk Aksiyon |
|---------|-------------|-------------|
| Workflow "pending activity" takılı | Dış servis (Jira/Bitbucket) 5xx | `docker compose logs worker \| tail -n 200`, dış servis durumu |
| "deterministic violation" hatası | Workflow kodunda side-effect | Activity'ye taşı; bkz. developer-guide |
| Prisma "table does not exist" | Migration çalıştırılmadı | `pnpm --filter @orkestra/db migrate` |
| Agent Studio 502 | `apps/studio` crash loop | `docker compose logs studio`, çoğu zaman env eksik |
| LLM 429 | Claude rate limit | `packages/llm` rate-limiter config, backoff otomatik |
| Sandbox zaman aşımı | Build uzun / kaynak yetersiz | `sandbox.timeoutSec` variant ayarı, host CPU |
| Webhook düşüyor | Jira → API ulaşamıyor | Network path + `X-Atlassian-Token` validation |
| Audit verify başarısız | Fiziksel tampering / disk bozulması | ACİL: runbook "Audit Tamper Response" bölümü |

## Acil Prosedürler (Özet)

- **Tüm workflow'ları duraklat:** `tctl taskqueue describe --taskqueue orkestra-main` ve worker'ı durdur (`docker compose stop worker`). Daha fazlası runbook'ta.
- **Tek müşteri stack'inde yeni deploy:** önce `pnpm docker:down`, yedek, `git pull`, `migrate`, `docker:up`, smoke-test.
- **Mock moda alma:** `.env` içinde `LLM_MODE=mock`, worker restart. Dış API çağrısı sıfırlanır.

## Daha Fazlası

- [`docs/runbook.md`](./runbook.md) — tam operasyon prosedürleri
- [`docs/install.md`](./install.md) — kurulum + ağ konfigürasyonu
- [`docs/architecture.md`](./architecture.md) — bileşen haritası
- [`SECURITY.md`](../SECURITY.md) — güvenlik olayı raporlama
