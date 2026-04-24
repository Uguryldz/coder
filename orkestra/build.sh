#!/usr/bin/env bash
# ============================================================================
#  Jira AI Orkestra — Build Script
#  Installs dependencies, generates Prisma client, builds all packages + apps.
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
NC="\033[0m"

log()  { echo -e "${GREEN}[build]${NC} $*"; }
warn() { echo -e "${YELLOW}[build]${NC} $*"; }
err()  { echo -e "${RED}[build]${NC} $*" >&2; }

# ---------- Preflight ----------
command -v pnpm >/dev/null 2>&1 || { err "pnpm bulunamadı — 'corepack enable && corepack prepare pnpm@10.33.0 --activate'"; exit 1; }
command -v node >/dev/null 2>&1 || { err "node bulunamadı"; exit 1; }

NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 22 ]; then
  warn "Node $NODE_MAJOR algılandı; Node 22 LTS önerilir"
fi

# ---------- Install ----------
log "bağımlılıklar kuruluyor..."
if [ -f pnpm-lock.yaml ]; then
  pnpm install --frozen-lockfile || pnpm install
else
  pnpm install
fi

# ---------- Prisma client ----------
log "prisma client üretiliyor..."
pnpm db:generate

# ---------- Turbo build ----------
log "paketler + uygulamalar derleniyor..."
pnpm build

# ---------- Optional: lint + typecheck for sanity ----------
if [ "${SKIP_CHECKS:-0}" != "1" ]; then
  log "typecheck çalışıyor..."
  pnpm typecheck

  log "lint çalışıyor (warning'ler tolere ediliyor)..."
  pnpm lint || warn "lint warning ile bitti"
fi

log "✅ build tamamlandı"
echo ""
echo "Sonraki adımlar:"
echo "  ./dev_run.sh    → dev ortamı (hot reload, mock LLM, port 7000)"
echo "  ./prod_run.sh   → prod ortamı (container, gerçek LLM, port 7000)"
