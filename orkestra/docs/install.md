# Kurulum Rehberi

## Sistem Gereksinimleri

- **Linux** (Ubuntu 22.04+ veya eşdeğeri). macOS dev için ok.
- **Docker** 24+ ve Docker Compose v2
- **Node.js** 22+ (build için)
- **pnpm** 10+ (`corepack enable && corepack prepare pnpm@10.33.0 --activate`)
- Minimum **4 CPU / 8 GB RAM** (10 ticket/gün ölçek)
- Ölçekli kurulum için **8 CPU / 16 GB RAM** (100 ticket/gün)

## Hızlı Kurulum (Dev / Demo)

```bash
# 1. Klon + install
git clone <repo>
cd orkestra
pnpm install

# 2. İnteraktif ayarlar
node scripts/install-wizard.mjs

# 3. Stack'i başlat (Postgres + Redis + MinIO + Vault + Temporal)
pnpm docker:up
# Hazır olmasını bekle (~30s)
docker compose -f deploy/compose/docker-compose.yml ps

# 4. Prisma migration + seed
pnpm --filter @orkestra/db generate
pnpm --filter @orkestra/db migrate
pnpm --filter @orkestra/db seed

# 5. API + Worker + Studio dev modda
pnpm dev
```

- **Studio:** http://localhost:3001 (admin@orkestra.local / orkestra-admin)
- **API:** http://localhost:3000
- **Temporal UI:** http://localhost:8233
- **MinIO Console:** http://localhost:9001 (orkestra / orkestra-dev-secret)

## Prod Kurulumu (On-Prem)

```bash
# 1. Sistem hazırlığı
sudo apt-get install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker

# 2. Kullanıcı (non-root)
sudo useradd -m -s /bin/bash orkestra
sudo usermod -aG docker orkestra
sudo -u orkestra -i

# 3. Kurulum paketini çıkar
tar xf orkestra-v0.1.0.tar.gz
cd orkestra

# 4. Wizard ile ayarla
node scripts/install-wizard.mjs

# 5. Image'ları pull et (air-gap için offline paketle yüklenebilir)
docker compose -f deploy/compose/docker-compose.yml pull

# 6. Başlat
pnpm docker:up

# 7. Migration + seed
docker compose -f deploy/compose/docker-compose.yml exec api \
  pnpm --filter @orkestra/db migrate
docker compose -f deploy/compose/docker-compose.yml exec api \
  pnpm --filter @orkestra/db seed
```

## Jira Webhook Konfigürasyonu

Jira DC'de **Admin → System → Webhooks → Create webhook**:

- **URL:** `https://<orkestra-host>/webhooks/jira`
- **Secret:** `.env` dosyasındaki `JIRA_WEBHOOK_SECRET`
- **Events:** Issue Created, Comment Created, Comment Updated
- **JQL Filter (opsiyonel):** `project in (PROJ1, PROJ2)` — sadece takip edilen projeler

Comment body'deki slash komutları (`/approve`, `/reject`, vb.) API tarafından otomatik dispatch edilir.

## Bitbucket Webhook Konfigürasyonu

Bitbucket DC'de her repo için **Repository settings → Webhooks → Create webhook**:

- **URL:** `https://<orkestra-host>/webhooks/bitbucket`
- **Secret:** `BITBUCKET_WEBHOOK_SECRET`
- **Events:** Pull request (opened/commented/approved/merged), Pipelines

## Jira Custom Fields

Platform şu custom field'ları bekler (isimleri Agent Studio → Settings'ten değiştirilebilir):

- `po_approver` — Analiz onayını verecek PO (User picker)
- `tech_lead` — Teknik onay ve PR onayı (User picker)
- `qa_lead` — Test onayı (User picker)
- `backup_po`, `backup_tech_lead`, `backup_qa` — SLA timeout'ta otomatik assign

Yoksa reporter'a fallback olur.

## Agent Studio İlk Oturum

1. Studio'ya giriş yap (seed edilen admin)
2. **Variants** sekmesinde her rol için otomatik oluşturulan variant'ları gör
3. Her variant için:
   - **Persona** — system prompt düzenle
   - **Knowledge** — kuralları, örnekleri, alan bilgisini yükle
   - **Test** — golden ticket üzerinde eval et
4. **Routing Rules** — Jira label/component → variant eşleştirmesi

## Parola Değiştirme

İlk girişten sonra **Settings → Account → Change Password**.

## Ölçeklendirme

```bash
# 100 ticket/gün
docker compose -f deploy/compose/docker-compose.yml up -d \
  --scale worker=3

# 500 ticket/gün (role bazlı)
WORKER_ROLE=developer docker compose up -d --scale worker=5
# ayrıca
WORKER_ROLE=analyst docker compose up -d --scale worker=3
```

## Güvenlik Kontrol Listesi

- [ ] `.env` dosyası `chmod 600` ve git-ignore'da
- [ ] Jira / Bitbucket / Anthropic token'lar Vault'a kondu (sadece dev'de .env)
- [ ] Webhook endpoint'leri HTTPS + HMAC imzalı
- [ ] Postgres ve Redis yalnızca iç ağda
- [ ] Docker socket worker'a read-only mount
- [ ] Log seviyesi prod'da `info` veya `warn` (debug değil)
- [ ] Backup cron'u aktif (bkz. runbook)

## Sorun Giderme

```bash
# Servis durumu
docker compose -f deploy/compose/docker-compose.yml ps

# Log'lar
docker compose -f deploy/compose/docker-compose.yml logs -f api
docker compose -f deploy/compose/docker-compose.yml logs -f worker

# Health
curl http://localhost:3000/health/ready

# Temporal workflow görüntüleme
# → http://localhost:8233 (UI'dan ticket-<KEY> ara)

# Workflow'u manuel iptal etme
curl -X POST http://localhost:3000/resources/workflowRun/<id> -d '{"status":"cancelled"}'
```
