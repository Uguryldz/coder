#!/usr/bin/env bash
# =============================================================================
# Maestro — ajan tanımlarındaki ERİŞİLEMEZ model denetimi
# =============================================================================
# Kullanım (bu klasörde):
#   ./ajan-modelleri.sh             # SADECE RAPOR — hiçbir şey değiştirmez
#   ./ajan-modelleri.sh --duzelt    # bulunanları "secilmedi" durumuna alır
#
# NEDEN VAR:
# Maestro'nun eski sürümleri, kurulum sırasında varsayılan ajanları bir BULUT
# modeliyle (örn. anthropic/claude-sonnet-4.5) tohumluyordu. Kurum içi ve
# internetsiz bir kurulumda o adlar hiçbir sunucuda yoktur — çağrı cevapsız
# kalır ve hata "bağlantı kurulamadı" diye YANLIŞ YERDE görünür.
#
# Yeni sürümler artık bulut adı tohumlamıyor. Ama kurulum, ZATEN VAR OLAN bir
# ajan tanımına ASLA DOKUNMAZ (yayınlanmış bir sürümü sessizce yeniden yazmak
# kabul edilemez), dolayısıyla eski kurulumdan kalan adlar güncellemeden sonra
# da yerinde durur. Bu betik, onları görmenin ve toplu düzeltmenin yoludur.
#
# NE YAPAR (--duzelt ile):
# Her ajanın YALNIZCA ETKİN (en yeni) sürümündeki model adını "secilmedi"
# yapar. Eski sürümler DEĞİŞMEZ — v4'e sabitlenmiş bir koşu v4'ün ne dediğini
# okumaya devam etmelidir. "secilmedi" bir silme değil, "operatör henüz
# seçmedi" durumudur: sistem bunu adıyla tanır, çağrıyı bağlantı panelindeki
# modelle yapar ve bunu GÖRÜNÜR bir uyarı satırıyla söyler.
#
# DAHA İYİ ALTERNATİF: tek tek düzeltecekseniz panelden yapın —
#   Ajan tanımları → ilgili ajan → yeni sürüm yayınla
# ve kendi model sunucunuzun servis ettiği adı yazın. Bu betik toplu ve hızlı
# yoldur; doğru model adını yine panelden vermeniz gerekir.
#
# deploy/banka/ajan-modelleri.sh ile deploy/ugurdocker/ajan-modelleri.sh
# BİLEREK birebir aynıdır; apps/deploy/test/variant-model-audit-bundle.test.ts
# bu ikizliği kilitler. Birini değiştiren diğerini de değiştirmelidir.
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$*"; }
err()  { printf '\033[31m✘\033[0m %s\n' "$*" >&2; }
info() { printf '\033[36m→\033[0m %s\n' "$*"; }
die()  { err "$*"; exit 1; }

DUZELT=0
case "${1:-}" in
  "") ;;
  --duzelt|--fix) DUZELT=1 ;;
  -h|--help)
    echo "Kullanım: ./ajan-modelleri.sh [--duzelt]"
    echo "  (argümansız) : sadece rapor, hiçbir şey değişmez"
    echo "  --duzelt     : bulunan bulut modellerini 'secilmedi' durumuna alır"
    exit 0
    ;;
  *) die "Bilinmeyen argüman: $1   (kullanım: ./ajan-modelleri.sh [--duzelt])" ;;
esac

# ── Ön koşullar ──────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker bulunamadı."
docker compose version >/dev/null 2>&1 || die "docker compose v2 bulunamadı."
docker info >/dev/null 2>&1 || die "docker daemon çalışmıyor ya da yetki yok (sudo?)."

# .env: compose dosyası zorunlu değişkenlerini (imaj adresleri, veritabanı
# parolası, COMPOSE_PROJECT_NAME) buradan okur — betik her zaman kendi
# klasörünün .env'ini kullanır, yani hangi yığına dokunduğu belirsiz kalmaz.
[[ -f .env ]] || die ".env yok. Bu betik kurulumun yapıldığı klasörde çalışır (install.sh ile aynı yer)."

pg_id=$(docker compose ps -q postgres 2>/dev/null || true)
if [[ -z "$pg_id" ]]; then
  err "postgres konteyneri çalışmıyor — yığın ayakta değil."
  err "  Önce yığını başlatın:  docker compose up -d"
  die "Denetim, çalışan bir veritabanı gerektirir."
fi

if [[ "$DUZELT" -eq 1 ]]; then
  info "Ajan tanımları taranıyor ve bulut modelleri 'secilmedi' durumuna alınacak…"
else
  info "Ajan tanımları taranıyor (SADECE RAPOR — hiçbir şey değişmeyecek)…"
fi
echo

# Aynı imaj, farklı giriş noktası — reset-admin.sh ile aynı desen.
RC=0
if [[ "$DUZELT" -eq 1 ]]; then
  docker compose run --rm \
    -e MAESTRO_ENTRYPOINT=apps/deploy/dist/bin/audit-variant-models.js \
    migrate --duzelt || RC=$?
else
  docker compose run --rm \
    -e MAESTRO_ENTRYPOINT=apps/deploy/dist/bin/audit-variant-models.js \
    migrate || RC=$?
fi

echo
if [[ "$RC" -eq 0 ]]; then
  if [[ "$DUZELT" -eq 1 ]]; then
    ok "Düzeltme tamam."
    warn "SIRADAKİ İŞ PANELDE: Ajan tanımları → her ajan → yeni sürüm yayınla"
    warn "  ve kendi model sunucunuzun servis ettiği model adını yazın."
  else
    ok "Temiz — erişilemez modele bağlı ajan tanımı yok."
  fi
elif [[ "$RC" -eq 3 ]]; then
  warn "Yukarıda listelenen ajan tanımları erişilemez bir bulut modeline bağlı."
  warn "Hiçbir şey DEĞİŞTİRİLMEDİ."
  warn "  Toplu düzeltme:  ./ajan-modelleri.sh --duzelt"
  warn "  Tek tek (önerilen): panel → Ajan tanımları → yeni sürüm yayınla"
  exit 3
else
  err "Denetim başarısız (çıkış kodu: ${RC})."
  err "  Veritabanı loglarına bakın:  docker compose logs postgres"
  die "Sorun sürerse migrate loglarıyla birlikte destek isteyin."
fi
