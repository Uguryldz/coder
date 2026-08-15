#!/usr/bin/env bash
# =============================================================================
# Maestro — banka içi (internetsiz) kurulum
# =============================================================================
# Kullanım (bu klasörde):
#   ./install.sh          # interaktif
#   ./install.sh --yes    # sorusuz (otomasyon için)
#
# Ön koşul: docker + compose v2 kurulu, imajlar `docker load` ile yüklenmiş,
#           .env doldurulmuş.
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$*"; }
err()  { printf '\033[31m✘\033[0m %s\n' "$*" >&2; }
info() { printf '\033[36m→\033[0m %s\n' "$*"; }
die()  { err "$*"; exit 1; }

AUTO_YES=0
[[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && AUTO_YES=1

onay() {  # onay <soru>  → --yes modunda otomatik evet
  [[ "$AUTO_YES" -eq 1 ]] && return 0
  read -r -p "$1 [e/H] " a
  [[ "$a" =~ ^[eEyY]$ ]]
}

echo "=================================================="
echo "  Maestro — banka içi kurulum"
echo "=================================================="

# ── 1) Ön koşullar ───────────────────────────────────────────────────────────
info "Ön koşullar kontrol ediliyor…"
command -v docker >/dev/null 2>&1 || die "docker bulunamadı."
docker compose version >/dev/null 2>&1 || die "docker compose v2 bulunamadı."
docker info >/dev/null 2>&1 || die "docker daemon çalışmıyor ya da yetki yok (sudo?)."
ok "docker + compose hazır."

CPU=$(nproc 2>/dev/null || echo "?")
RAM=$(awk '/MemTotal/ {printf "%.0f", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo "?")
info "Kaynak: ${CPU} CPU / ${RAM} GB RAM"
if [[ "$RAM" != "?" && "$RAM" -lt 8 ]]; then
  warn "RAM ${RAM} GB — asgari 8 GB önerilir."
  onay "Yine de devam edilsin mi?" || exit 0
fi

# ── 2) .env ──────────────────────────────────────────────────────────────────
[[ -f .env ]] || die ".env yok.  cp .env.example .env  yapıp doldurun."
chmod 600 .env 2>/dev/null || true
ok ".env mevcut."

# shellcheck disable=SC1091
set -a; . ./.env; set +a

# Doldurulmamış alanlar
if grep -q "DEGISTIR" .env; then
  err ".env içinde DEGISTIR kalmış — doldurulmamış alan var:"
  grep -n "DEGISTIR" .env | sed 's/^/    /'
  die "Bu alanları doldurup tekrar çalıştırın."
fi
ok "Doldurulmamış alan yok."

# ── 3) Sık yapılan yapılandırma hataları ─────────────────────────────────────
info "Yapılandırma tutarlılığı…"

# LLM_BASE_URL sonunda /v1 → sürücü de ekler → /v1/v1 → her çağrı 404
if [[ "${LLM_BASE_URL:-}" =~ /v1/?$ ]]; then
  err "LLM_BASE_URL sonunda '/v1' var: ${LLM_BASE_URL}"
  err "  Sürücü '/v1/chat/completions' ekler; bu hâliyle '/v1/v1/...' olur ve"
  err "  her model çağrısı 404 döner. Sondaki '/v1' kısmını silin."
  die "LLM_BASE_URL düzeltilmeli."
fi

# Kurum içi endpoint ama on-prem bayrağı kapalı → gizli veri maskelenir
if [[ "${LLM_ON_PREM:-}" != "true" ]]; then
  warn "LLM_ON_PREM='${LLM_ON_PREM:-}' — 'true' değil."
  warn "  Bu hâlde 'gizli' sınıflı işler maskelenir ya da reddedilir."
  onay "Bilerek mi böyle?" || die "LLM_ON_PREM=true yapın."
fi

# Boş LLM anahtarı → ilk çağrıdan önce SecretNotFoundError
[[ -n "${MAESTRO_SECRET_LLM_API_KEY:-}" ]] \
  || die "MAESTRO_SECRET_LLM_API_KEY boş. Yetki istemeyen uç nokta için bile dolu bir değer gerekir."

# Kurumsal CA dosyası gerçekten var mı
if [[ -n "${NODE_EXTRA_CA_CERTS:-}" ]]; then
  CA_LOCAL="${CA_BUNDLE_DIR:-./certs}/$(basename "${NODE_EXTRA_CA_CERTS}")"
  if [[ ! -f "$CA_LOCAL" ]]; then
    err "NODE_EXTRA_CA_CERTS=${NODE_EXTRA_CA_CERTS} ayarlı ama dosya yok: ${CA_LOCAL}"
    err "  Banka kök CA'sını '${CA_BUNDLE_DIR:-./certs}' klasörüne koyun."
    die "CA dosyası eksik."
  fi
  ok "Kurumsal CA bulundu: ${CA_LOCAL}"
else
  warn "NODE_EXTRA_CA_CERTS boş — Jira/TFS sertifikası kurum CA'sıyla imzalıysa"
  warn "  bağlantılar 'unable to verify the first certificate' ile düşer."
fi

# LDAP seçiliyse alanları dolu mu
if [[ "${IDENTITY_DRIVER:-}" == "ldaps-bind" ]]; then
  for v in LDAP_URL LDAP_BIND_DN LDAP_BASE_DN; do
    [[ -n "${!v:-}" ]] || die "IDENTITY_DRIVER=ldaps-bind ama ${v} boş."
  done
  ok "LDAP alanları dolu."
fi
ok "Yapılandırma tutarlı."

# ── 4) İmajlar yerelde mi ────────────────────────────────────────────────────
info "İmajlar kontrol ediliyor…"
EKSIK=0
for img in "${MAESTRO_NODE_IMAGE}" "${MAESTRO_STUDIO_IMAGE}" \
           "${POSTGRES_IMAGE}" "${REDIS_IMAGE}" "${TEMPORAL_IMAGE}"; do
  if docker image inspect "$img" >/dev/null 2>&1; then
    ok "  $img"
  else
    err "  $img — YOK"
    EKSIK=1
  fi
done
if [[ "$EKSIK" -eq 1 ]]; then
  err "Eksik imaj var. İnternetsiz sunucuda build yapılamaz."
  err "  Çözüm:  gunzip -c maestro-imajlar-<TAG>.tar.gz | docker load"
  err "  (kurum registry'si varsa: docker compose pull)"
  die "İmajları yükleyip tekrar çalıştırın."
fi

# ── 5) İmaj sağlığı (bayat/bozuk imaj erken yakalansın) ──────────────────────
info "İmaj doğrulanıyor…"
if docker run --rm --entrypoint sh "${MAESTRO_NODE_IMAGE}" -c "openssl version" >/dev/null 2>&1; then
  ok "  OpenSSL kurulu (Prisma query engine için gerekli)."
else
  warn "  İmajda OpenSSL YOK. Prisma sürüm tahmini yapar; sorun çıkarsa"
  warn "  imajı yeniden build edin (README §1.3)."
fi
MIG_SAYI=$(docker run --rm --entrypoint sh "${MAESTRO_NODE_IMAGE}" \
  -c "ls /app/packages/db/prisma/migrations 2>/dev/null | wc -l" 2>/dev/null || echo 0)
if [[ "${MIG_SAYI}" -gt 0 ]]; then
  ok "  Migration dosyası: ${MIG_SAYI} adet."
else
  die "  İmajda migration bulunamadı — imaj bozuk/bayat. Yeniden build edin."
fi

# ── 6) Compose doğrula ───────────────────────────────────────────────────────
info "Compose doğrulanıyor…"
docker compose config >/dev/null || die "compose config HATALI (.env eksik/yanlış?)."
ok "Compose geçerli."

# ── 7) Başlat ────────────────────────────────────────────────────────────────
info "Veri katmanı başlatılıyor…"
docker compose up -d postgres redis temporal

info "Şema kuruluyor (migrate)…"
if ! docker compose run --rm migrate; then
  err "Migration başarısız. Log:  docker compose logs migrate"
  die "Şema kurulamadı."
fi
ok "Şema kuruldu."

info "Uygulama başlatılıyor…"
docker compose up -d

# ── 8) Sağlık ────────────────────────────────────────────────────────────────
echo
info "Servislerin hazır olması bekleniyor (~90 sn)…"
HAZIR=0
for i in $(seq 1 30); do
  bff=$(docker inspect maestro-bff --format '{{.State.Health.Status}}' 2>/dev/null || echo "")
  std=$(docker inspect maestro-studio --format '{{.State.Health.Status}}' 2>/dev/null || echo "")
  if [[ "$bff" == "healthy" && "$std" == "healthy" ]]; then HAZIR=1; break; fi
  sleep 5
done

echo
docker compose ps
echo
if [[ "$HAZIR" -eq 1 ]]; then
  ok "KURULUM TAMAM."
else
  warn "Servisler beklenen sürede 'healthy' olmadı — aşağıdaki logları inceleyin."
fi

PORT="${STUDIO_PORT:-7000}"
echo
echo "  Panel   : http://<SUNUCU_IP>:${PORT#*:}"
echo "  Loglar  : docker compose logs -f bff"
echo "  Durum   : docker compose ps"
echo "  Yedek   : docker compose exec -T postgres pg_dump -U ${POSTGRES_USER} ${POSTGRES_DB} | gzip > yedek.sql.gz"
echo
warn "ASLA 'docker compose down -v' çalıştırmayın — veritabanını siler."
