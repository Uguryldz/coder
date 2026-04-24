#!/usr/bin/env bash
# ============================================================================
#  Jira AI Orkestra — Dev Run
#
#  Harici uinfra network'ündeki Postgres + Redis'i kullanır.
#  Orkestra container'ları (api, worker, studio + minio, vault, temporal) aynı
#  network'e bağlanır, hot reload için source bind-mount yapılır.
#
#  Gereksinim:
#    cd ~/uinfra && docker compose up -d   # postgres + redis çalışıyor olmalı
#
#  Kullanım:
#    ./dev_run.sh               → başlat + log göster
#    ./dev_run.sh logs [srv]    → sadece log
#    ./dev_run.sh ps            → servis durumu
#    ./dev_run.sh rebuild       → image'ları yeniden build + başlat
#    ./dev_run.sh stop          → durdur
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

GREEN="\033[0;32m"
YELLOW="\033[1;33m"
BLUE="\033[0;34m"
RED="\033[0;31m"
NC="\033[0m"

log()  { echo -e "${GREEN}[dev]${NC} $*"; }
warn() { echo -e "${YELLOW}[dev]${NC} $*"; }
info() { echo -e "${BLUE}[dev]${NC} $*"; }
err()  { echo -e "${RED}[dev]${NC} $*" >&2; }

# ---------- .env ----------
if [ ! -f .env ]; then
  warn ".env yok — .env.example kopyalanıyor"
  cp .env.example .env
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

export STUDIO_HOST_PORT="${STUDIO_HOST_PORT:-7000}"
export API_HOST_PORT="${API_HOST_PORT:-7001}"
export MINIO_HOST_PORT="${MINIO_HOST_PORT:-9010}"
export MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-9011}"
export VAULT_HOST_PORT="${VAULT_HOST_PORT:-8200}"
export TEMPORAL_HOST_PORT="${TEMPORAL_HOST_PORT:-7233}"
export TEMPORAL_UI_HOST_PORT="${TEMPORAL_UI_HOST_PORT:-8233}"
export LLM_MODE="${LLM_MODE:-mock}"
export NODE_ENV="${NODE_ENV:-development}"

COMPOSE_FILE="deploy/compose/docker-compose.yml"
COMPOSE="docker compose --env-file $(pwd)/.env -f ${COMPOSE_FILE}"

# ---------- Komut yönlendirme ----------
case "${1:-up}" in
  stop|down)
    log "container'lar durduruluyor..."
    $COMPOSE down
    exit 0
    ;;
  logs)
    shift || true
    exec $COMPOSE logs -f --tail 200 "$@"
    ;;
  ps|status)
    exec $COMPOSE ps
    ;;
  rebuild)
    log "image'lar yeniden build ediliyor..."
    $COMPOSE build --no-cache api worker studio
    $COMPOSE up -d
    log "✅ rebuild + restart tamam"
    exit 0
    ;;
  up|"") ;;
  *)
    err "bilinmeyen komut: $1"
    echo "Kullanım: $0 [up|stop|restart|logs [servis]|ps|rebuild]"
    exit 2
    ;;
esac

# ---------- Preflight ----------
command -v docker >/dev/null 2>&1 || { err "docker bulunamadı"; exit 1; }
docker compose version >/dev/null 2>&1 || { err "docker compose v2 bulunamadı"; exit 1; }

# uinfra network var mı?
if ! docker network inspect uinfra >/dev/null 2>&1; then
  err "'uinfra' network bulunamadı."
  err "Önce harici altyapıyı başlat:"
  err "   cd ~/uinfra && docker compose up -d"
  exit 1
fi

# Postgres + Redis uinfra'da çalışıyor mu?
for svc in uinfra-postgres uinfra-redis; do
  if ! docker ps --format '{{.Names}}' | grep -qx "$svc"; then
    err "$svc çalışmıyor — cd ~/uinfra && docker compose up -d"
    exit 1
  fi
done
log "uinfra Postgres + Redis hazır ✓"

# ---------- Image build (ilk çalıştırmada) ----------
if ! docker images | grep -q "compose-api\|orkestra.*api"; then
  log "image'lar ilk kez build ediliyor (~3-5 dk)..."
  $COMPOSE build api worker studio
fi

# ---------- Stack'i kaldır ----------
log "Orkestra stack başlatılıyor (uinfra network'üne bağlanıyor)..."
$COMPOSE up -d

# db-init'in tamamlanmasını bekle
info "db-init çalışıyor (orkestra + temporal + temporal_visibility DB'leri)..."
for i in {1..30}; do
  status=$($COMPOSE ps db-init --format json 2>/dev/null | grep -oE '"State":"[^"]*"' | head -1 || true)
  if echo "$status" | grep -q "exited"; then
    log "db-init tamamlandı"; break
  fi
  sleep 2
done

info "temporal hazır olması bekleniyor (~30s)..."
for i in {1..60}; do
  if $COMPOSE exec -T temporal tctl --address temporal:7233 cluster health >/dev/null 2>&1; then
    log "temporal hazır ✓"; break
  fi
  sleep 2
done

# prisma-migrate init container migrate + seed'i otomatik yapar (compose'da tanımlı)
log "prisma-migrate init container migrate + seed'i hallediyor..."

# ---------- API health ----------
info "API /health/ready bekleniyor..."
for i in {1..30}; do
  if curl -fs "http://localhost:${API_HOST_PORT}/health/ready" >/dev/null 2>&1; then
    log "API hazır ✓"; break
  fi
  sleep 2
done

# ---------- Özet ----------
cat <<EOF

╔═══════════════════════════════════════════════════════════════╗
║   Jira AI Orkestra — Dev Modu Çalışıyor                       ║
╠═══════════════════════════════════════════════════════════════╣
║                                                                ║
║   👉  Agent Studio : http://localhost:${STUDIO_HOST_PORT}                   ║
║       API          : http://localhost:${API_HOST_PORT}                   ║
║       Temporal UI  : http://localhost:${TEMPORAL_UI_HOST_PORT}                   ║
║       MinIO Console: http://localhost:${MINIO_CONSOLE_PORT}                   ║
║                                                                ║
║   Admin       : admin@orkestra.local / orkestra-admin         ║
║   LLM mode    : ${LLM_MODE}                                          ║
║   Network     : uinfra (external)                             ║
║   Postgres    : uinfra-postgres (sa@postgres:5432/orkestra)   ║
║   Redis       : uinfra-redis (redis:6379/db1)                 ║
║                                                                ║
║   Yönetim:                                                    ║
║     ./dev_run.sh logs [servis]   → canlı log                 ║
║     ./dev_run.sh ps              → servis durumu             ║
║     ./dev_run.sh rebuild         → image yeniden build       ║
║     ./dev_run.sh stop            → durdur                    ║
║                                                                ║
╚═══════════════════════════════════════════════════════════════╝

EOF

log "✅ stack ayakta — canlı log için: ./dev_run.sh logs"
