# Runbook — Production Operasyon

## Günlük İşlemler

### Sağlık Kontrolü

```bash
curl -s http://localhost:3000/health/ready | jq
docker compose -f deploy/compose/docker-compose.yml ps
```

Beklenen: tüm servisler "healthy", `db: ok`, `redis: ok`.

### Log İzleme

```bash
docker compose -f deploy/compose/docker-compose.yml logs -f --tail 100
```

API log formatı JSON (Pino). `correlationId` ile bir ticket'ın tüm log'larını filtrele:

```bash
docker compose logs api | grep 'correlationId":"<id>"'
```

## Ölçeklendirme

### Worker sayısı

```bash
# Varsayılan (her rol aynı worker'da)
docker compose up -d --scale worker=3

# Role-specific (yüksek ölçek)
docker compose up -d \
  --scale worker=1 \
  # + additional worker services with WORKER_ROLE=developer, WORKER_ROLE=analyst
```

### Kapasite tavsiyeleri

| Hedef | CPU | RAM | Worker replika |
|-------|-----|-----|----------------|
| 10 ticket/gün | 4 | 8GB | 1 |
| 100 ticket/gün | 8 | 16GB | 3 |
| 500 ticket/gün | 16 | 32GB | 8-10 (role bazlı) |

**Sandbox kapasitesi:** `SANDBOX_MAX_CONCURRENT` env var (default CPU/4). Aşım Temporal activity retry'a düşer.

## Backup & Restore

### Günlük backup (cron)

```bash
# /etc/cron.daily/orkestra-backup
#!/bin/sh
TS=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/var/backups/orkestra/$TS
mkdir -p $BACKUP_DIR

# Postgres
docker compose -f /opt/orkestra/deploy/compose/docker-compose.yml exec -T postgres \
  pg_dumpall -U postgres | gzip > $BACKUP_DIR/postgres.sql.gz

# MinIO (knowledge pack, artifacts)
docker compose exec -T minio mc mirror local/orkestra $BACKUP_DIR/minio/

# Vault (secrets — encrypted with unseal key)
docker compose exec -T vault vault operator raft snapshot save /tmp/vault.snap
docker cp orkestra-vault:/tmp/vault.snap $BACKUP_DIR/vault.snap

# Retention: keep last 30 daily + 12 monthly
find /var/backups/orkestra -maxdepth 1 -type d -mtime +30 -exec rm -rf {} \;
```

### Restore

```bash
# 1. Stack'i durdur
docker compose down

# 2. Postgres restore
docker compose up -d postgres
zcat postgres.sql.gz | docker compose exec -T postgres psql -U postgres

# 3. MinIO restore
docker compose up -d minio
mc mirror backup/minio/ local/orkestra/

# 4. Vault restore
docker compose up -d vault
vault operator raft snapshot restore vault.snap
```

## Upgrade (Yeni Sürüm)

**Temporal workflow versioning disiplini** — çalışan workflow'lar (72h+) eski kodla bitmelidir.

```bash
# 1. Backup al (yukarıda)

# 2. Yeni sürümü indir
git fetch --tags
git checkout v0.2.0

# 3. Pre-flight check
pnpm --filter @orkestra/db exec prisma migrate diff --preview-feature

# 4. Migration preview
pnpm --filter @orkestra/db exec prisma migrate deploy --dry-run

# 5. Yeni image'ları çek
docker compose pull

# 6. Zero-downtime upgrade:
# - API'ları bir bir yeniden başlat
# - Worker'lar eski workflow'ları bitirir, yeni workflow'lar yeni sürümle
docker compose up -d --no-deps --force-recreate api worker studio

# 7. Doğrulama
curl http://localhost:3000/version
curl http://localhost:3000/health/ready
```

## Monitoring & Uyarılar

### Manuel kontrol

- **Bekleyen workflow'lar:** Agent Studio → Dashboard → "Waiting Human"
- **Bloklu workflow'lar:** Dashboard → "Blocked" (insan müdahalesi gerek)
- **Bütçe aşımı:** Slack'e kritik bildirim gelir
- **CI Gate fail:** Jira yorumuna düşer, workflow 6a'ya döner

### Prometheus / Grafana (v2)

v2'de `/metrics` endpoint'i açılacak. Şimdilik structured JSON log'lar üzerinden Loki/OpenSearch gibi loglara forward edilebilir.

## Sorun Giderme

### "Workflow stuck"

```bash
# Temporal UI → Active workflows → Ticket'ı bul → "Query" → get-status
# Veya DB sorgusu
docker compose exec postgres psql -U orkestra orkestra -c \
  "SELECT id, status, current_step, started_at FROM \"WorkflowRun\" WHERE status='running';"
```

Çözümler:
- `status: waiting_po` çok uzunsa → SLA timeout bekleniyor
- `status: blocked` → log'lara bak, hata ne
- Manuel iptal: `POST /resources/workflowRun/<id>` body `{"status":"cancelled"}`

### "Claude API 429"

Rate limit. Worker'lar backpressure devresi ile tekrar dener. Eğer sürekli 429:
- `ANTHROPIC_RPM_LIMIT` ve `ANTHROPIC_TPM_INPUT_LIMIT` env'lerini azalt
- Anthropic tier'ı yüksekselt

### "Sandbox capacity exhausted"

```bash
# Çalışan sandbox container sayısı
docker ps --filter label=orkestra.role=sandbox --format json | wc -l
```

Çözümler:
- `SANDBOX_MAX_CONCURRENT` artır
- CPU/RAM yükselt
- Ticket kuyrukta bekler, otomatik devam eder

### "Cost budget exceeded"

Workflow yorumuna "💰 Bütçe aşıldı" düşer. İnsan müdahalesi bekleniyor.

- Bütçeyi artırmak için: Agent Studio → Settings → Cost → artır, workflow'u `/retry` ile tekrar dene
- Genel limit: `.env` `COST_BUDGET_PER_WORKFLOW_USD`

## Diagnostic CLI (v2)

```bash
# v2 — şimdilik manuel
docker compose logs > logs.txt
docker compose ps > services.txt
docker compose exec postgres psql -U orkestra -c "\dt" > schema.txt
# Bundle'ı destek için gönder
tar czf diag-$(date +%s).tgz logs.txt services.txt schema.txt
```

## Audit Chain Doğrulama

```bash
curl http://localhost:3000/audit/verify
# { "ok": true } — zincir temiz
# { "ok": false, "tamperedFirstId": "123" } — 123. entry'den itibaren bozulmuş
```
