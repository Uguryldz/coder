#!/usr/bin/env bash
# ============================================================================
#  Jira AI Orkestra — Prod Run
#
#  Harici uinfra network'ündeki Postgres + Redis'i kullanır.
#  Tüm Orkestra stack container'ize, production config ile.
#
#  Gereksinim:
#    - uinfra çalışıyor (cd ~/uinfra && docker compose up -d)
#    - .env dosyası hazır (node scripts/install-wizard.mjs)
#    - ANTHROPIC_API_KEY dolu (LLM_MODE=real için)
#
#  Kullanım:
#    ./prod_run.sh              → image build + start
#    ./prod_run.sh logs [srv]
#    ./prod_run.sh ps
#    ./prod_run.sh restart
#    ./prod_run.sh stop
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

GREEN="\033[0;32m"
YELLOW="\033[1;33m"
BLUE="\033[0;34m"
RED="\033[0;31m"
NC="\033[0m"

log()  { echo -e "${GREEN}[prod]${NC} $*"; }
warn() { echo -e "${YELLOW}[prod]${NC} $*"; }
info() { echo -e "${BLUE}[prod]${NC} $*"; }
err()  { echo -e "${RED}[prod]${NC} $*" >&2; }

# ---------- Ayarlar ----------
export STUDIO_HOST_PORT="${STUDIO_HOST_PORT:-7000}"
export API_HOST_PORT="${API_HOST_PORT:-7001}"
export LLM_MODE="${LLM_MODE:-real}"
export NODE_ENV="production"

COMPOSE_FILE="deploy/compose/docker-compose.yml"
COMPOSE="docker compose --env-file $(pwd)/.env -f ${COMPOSE_FILE}"

# ---------- .env ----------
if [ ! -f .env ]; then
  err ".env yok — önce: node scripts/install-wizard.mjs"
  exit 1
fi
# shellcheck disable=SC1091
set -a; . ./.env; set +a

# ---------- Preflight ----------
command -v docker >/dev/null 2>&1 || { err "docker bulunamadı"; exit 1; }
docker compose version >/dev/null 2>&1 || { err "docker compose v2 bulunamadı"; exit 1; }

# uinfra var mı?
if ! docker network inspect uinfra >/dev/null 2>&1; then
  err "'uinfra' network yok — önce: cd ~/uinfra && docker compose up -d"
  exit 1
fi

if [ "${LLM_MODE}" = "real" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  err "LLM_MODE=real için ANTHROPIC_API_KEY (.env) zorunlu"
  exit 1
fi

if [ -z "${NEXTAUTH_SECRET:-}" ] || [ "${NEXTAUTH_SECRET}" = "change-me" ]; then
  err "NEXTAUTH_SECRET (.env) güçlü bir değere ayarlanmalı"
  exit 1
fi

# ---------- Komut desteği ----------
case "${1:-up}" in
  stop|down)
    log "stack durduruluyor..."
    $COMPOSE down
    exit 0
    ;;
  restart)
    log "stack yeniden başlatılıyor..."
    $COMPOSE down
    ;;
  logs)
    shift || true
    exec $COMPOSE logs -f --tail 200 "$@"
    ;;
  ps|status)
    exec $COMPOSE ps
    ;;
  rebuild)
    log "image'lar no-cache build ediliyor..."
    $COMPOSE build --no-cache api worker studio
    $COMPOSE up -d
    exit 0
    ;;
  up|"") ;;
  *)
    err "bilinmeyen komut: $1"
    echo "Kullanım: $0 [up|stop|restart|logs [srv]|ps|rebuild]"
    exit 2
    ;;
esac

# ---------- Build ----------
log "image'lar build ediliyor (ilk çalıştırmada ~5-10 dk)..."
$COMPOSE build api worker studio

# ---------- Start ----------
log "stack başlatılıyor..."
$COMPOSE up -d

# db-init bekle
info "db-init çalışıyor..."
for i in {1..30}; do
  if docker ps -a --format '{{.Names}} {{.Status}}' | grep -E "orkestra-db-init.*Exited \(0\)" >/dev/null; then
    log "db-init tamam ✓"; break
  fi
  sleep 2
done

info "temporal hazır olması bekleniyor..."
for i in {1..60}; do
  if $COMPOSE exec -T temporal tctl --address temporal:7233 cluster health >/dev/null 2>&1; then
    log "temporal hazır ✓"; break
  fi
  sleep 2
done

# prisma-migrate init container migrate + seed'i otomatik yapar
log "prisma-migrate init container migrate + seed'i hallediyor..."

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
║   Jira AI Orkestra — Prod Modu Çalışıyor                      ║
╠═══════════════════════════════════════════════════════════════╣
║                                                                ║
║   👉  Agent Studio : http://localhost:${STUDIO_HOST_PORT}                   ║
║       API          : http://localhost:${API_HOST_PORT}                   ║
║          /webhooks/jira      (Jira webhook)                  ║
║          /webhooks/bitbucket (Bitbucket webhook)             ║
║          /health/ready       (sağlık)                        ║
║                                                                ║
║   LLM mode  : ${LLM_MODE}                                          ║
║   Network   : uinfra (external)                              ║
║                                                                ║
║   ./prod_run.sh logs [srv]       → canlı log                 ║
║   ./prod_run.sh ps               → servis durumu             ║
║   ./prod_run.sh rebuild          → no-cache build + restart  ║
║   ./prod_run.sh stop             → durdur                    ║
║                                                                ║
║   Prod kontrolleri:                                          ║
║     - HTTPS (Nginx reverse proxy)                            ║
║     - Firewall: 7000 + 7001 + SSH                            ║
║     - Backup cron                                            ║
║                                                                ║
╚═══════════════════════════════════════════════════════════════╝

EOF

log "✅ stack ayakta"
