#!/usr/bin/env bash
# =============================================================================
# Maestro — TANI PAKETİ (tek HTML dosyası)
# =============================================================================
# Kullanım (bu klasörde):
#   ./tani.sh                      # her şey, servis başına son 200 satır log
#   ./tani.sh --satir 500          # daha uzun log kuyruğu
#   ./tani.sh --jira-yok           # canlı Jira denemesini ATLA
#   ./tani.sh --ticket ABC-123     # canlı okumada bu ticket'ı kullan
#   ./tani.sh --cikti /yol/rapor.html
#
# Çıktı: maestro-tani-YYYYAAGG-SSDD.html — TEK dosya, gömülü CSS, HARİCİ KAYNAK
# YOK. Bu bir tercih değil zorunluluk: dosya internetsiz bir sunucuda üretilir,
# çoğu zaman orada açılır, ve bir CDN bağlantısı orada sessizce başarısız olur —
# sayfa açılır, biçimsizdir, operatör aracın bozuk olduğunu sanır.
#
# ── NEDEN VAR ────────────────────────────────────────────────────────────────
# Bir şey çalışmadığında bugüne dek yapılan şey şuydu: `docker compose logs`
# çıktısı parça parça terminalden kopyalanıp gönderiliyordu. Teşhis için gereken
# satır o çıktının içinde gerçekten vardı — ama yanında postgres'in checkpoint
# satırları, temporal'ın yaşam döngüsü satırları ve nginx'in 200 dönen erişim
# satırları da vardı, binlercesi. Bu betik onların yerine tek bir sayfa üretir:
# önce YAPILANDIRMA TEŞHİSİ (cevap neredeyse her zaman orada), sonra akış
# durumu, sonra Jira'ya canlı deneme, en sonda gürültüsü ayıklanmış log'lar.
#
# ── SIR POLİTİKASI ───────────────────────────────────────────────────────────
# Bu dosya TASARIM GEREĞİ birine gönderilir. Hiçbir jeton/parola/anahtar DEĞERİ
# yazılmaz — yalnızca "tanımlı"/"tanımsız". URL'lerdeki `//kullanıcı:parola@`
# maskelenir, log satırları da maskeden geçer. Yine de: göndermeden önce bir
# göz atın; bu bir taahhüt değil, en iyi çabadır.
#
# ── YAN ETKİ YOK ─────────────────────────────────────────────────────────────
# Hiçbir tabloya yazılmaz, hiçbir ticket'a yorum düşülmez, hiçbir statü
# GEÇİRİLMEZ (geçişler yalnızca listelenir). Canlı bir yığında güvenle
# çalıştırılabilir.
#
# deploy/banka/tani.sh ile deploy/ugurdocker/tani.sh BİLEREK birebir aynıdır;
# apps/deploy/test/tani-bundle.test.ts bu ikizliği kilitler. Birini değiştiren
# diğerini de değiştirmelidir.
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$*"; }
err()  { printf '\033[31m✘\033[0m %s\n' "$*" >&2; }
info() { printf '\033[36m→\033[0m %s\n' "$*"; }
die()  { err "$*"; exit 1; }

SATIR=200
JIRA_YOK=0
TICKET=""
CIKTI=""

kullanim() {
  cat <<'YARDIM'
Kullanım: ./tani.sh [seçenekler]
  --satir <n>        servis başına toplanacak log satırı (varsayılan: 200)
  --jira-yok         canlı Jira denemesini atla
  --ticket <ANAHTAR> canlı okumada kullanılacak ticket (varsayılan: en son koşu)
  --cikti <yol>      HTML dosyasının yazılacağı yol
  -h, --help         bu yardım
YARDIM
}

# Bilinmeyen argüman REDDEDİLİR. `./tani.sh --satirr 500` sessizce 200 satırlık
# bir rapor üretseydi, operatör istediği veriyi aldığını sanırdı — ve tanı
# aracının verebileceği en kötü cevap, eksik olduğunu söylemeyen bir cevaptır.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --satir)
      [[ $# -ge 2 ]] || die "--satir bir sayı bekler."
      [[ "$2" =~ ^[0-9]+$ ]] || die "--satir bir sayı olmalı: $2"
      [[ "$2" -gt 0 ]] || die "--satir sıfırdan büyük olmalı."
      SATIR="$2"; shift 2 ;;
    --jira-yok) JIRA_YOK=1; shift ;;
    --ticket)
      [[ $# -ge 2 ]] || die "--ticket bir ticket anahtarı bekler (örn. ABC-123)."
      TICKET="$2"; shift 2 ;;
    --cikti)
      [[ $# -ge 2 ]] || die "--cikti bir dosya yolu bekler."
      CIKTI="$2"; shift 2 ;;
    -h|--help) kullanim; exit 0 ;;
    *) err "Bilinmeyen argüman: $1"; echo; kullanim; exit 1 ;;
  esac
done

# ── Ön koşullar ──────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker bulunamadı."
docker compose version >/dev/null 2>&1 || die "docker compose v2 bulunamadı."
docker info >/dev/null 2>&1 || die "docker daemon çalışmıyor ya da yetki yok (sudo/dzdo?)."

# .env: compose dosyası zorunlu değişkenlerini (imaj adresleri, veritabanı
# parolası, COMPOSE_PROJECT_NAME) buradan okur — betik her zaman kendi
# klasörünün .env'ini kullanır, yani hangi yığını teşhis ettiği belirsiz kalmaz.
[[ -f .env ]] || die ".env yok. Bu betik kurulumun yapıldığı klasörde çalışır (install.sh ile aynı yer)."

pg_id=$(docker compose ps -q postgres 2>/dev/null || true)
if [[ -z "$pg_id" ]]; then
  err "postgres konteyneri çalışmıyor — yığın ayakta değil."
  err "  Önce yığını başlatın:  docker compose up -d"
  die "Tanı, çalışan bir veritabanı gerektirir."
fi

if [[ -z "$CIKTI" ]]; then
  CIKTI="maestro-tani-$(date +%Y%m%d-%H%M).html"
fi

# ── 1) Sunucudan toplanabilenler ─────────────────────────────────────────────
# Bunları YALNIZ host yapabilir: docker soketi konteynerin içinde yok. Konteyner
# tarafındaki yarı (yapılandırma, veritabanı, canlı Jira) aşağıda, imajın
# içinde koşuyor.
info "Servis log'ları toplanıyor (servis başına son ${SATIR} satır)…"

SERVISLER=(bff worker migrate studio postgres redis temporal autoheal)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# JSON'u python ile kuruyoruz: bir log satırı her karakteri içerebilir (tırnak,
# ters bölü, kontrol karakteri) ve elle kaçırmaya çalışmak, tam da o satırda
# bozulan bir JSON demektir. python3 her modern dağıtımda var; yoksa aşağıda
# adıyla söyleyip duruyoruz.
command -v python3 >/dev/null 2>&1 \
  || die "python3 bulunamadı — bu betik JSON üretmek için ona ihtiyaç duyuyor."

for servis in "${SERVISLER[@]}"; do
  # `|| true`: tanımlı olmayan bir servis (ugurdocker'da autoheal yok) ya da hiç
  # başlamamış bir konteyner raporu ÖLDÜRMEMELİ — eksikliği sayfada görünür.
  docker compose logs --no-color --tail "${SATIR}" "${servis}" >"${TMP}/${servis}.log" 2>&1 || true
done

HOSTADI="$(hostname 2>/dev/null || echo bilinmiyor)"
IMAJ="$(grep -oE '^MAESTRO_NODE_IMAGE=.*' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)"
IMAJ="${IMAJ:-bilinmiyor}"
ZAMAN="$(date '+%Y-%m-%d %H:%M:%S %Z')"

python3 - "$TMP" "$HOSTADI" "$IMAJ" "$ZAMAN" "$SATIR" "$TICKET" "$JIRA_YOK" >"${TMP}/girdi.json" <<'PY'
import json, os, sys
tmp, host, imaj, zaman, satir, ticket, jira_yok = sys.argv[1:8]
loglar = {}
for ad in sorted(os.listdir(tmp)):
    if not ad.endswith(".log"):
        continue
    with open(os.path.join(tmp, ad), "r", encoding="utf-8", errors="replace") as fh:
        loglar[ad[:-4]] = fh.read().splitlines()
json.dump({
    "hostAdi": host,
    "imajSurumu": imaj,
    "uretimZamani": zaman,
    "satirSayisi": int(satir),
    "ornekTicket": ticket,
    "jiraTesti": jira_yok != "1",
    "loglar": loglar,
}, sys.stdout)
PY

# ── 2) Yığının içinden okunabilenler + sayfanın kendisi ──────────────────────
# Aynı imaj, farklı giriş noktası — reset-admin.sh ve ajan-modelleri.sh ile aynı
# desen, aynı gerekçe: Prisma istemcisi ve Jira sürücüsü imajın derli
# node_modules'ından gelir, sunucuya node/pnpm kurulmaz.
#
# `-T`: TTY ayrılmaz, çünkü girdiyi boru ile veriyoruz — TTY ayrılsaydı stdin
# terminale bağlanır ve komut sonsuza dek boş bir girdiyi beklerdi.
if [[ "$JIRA_YOK" -eq 1 ]]; then
  info "Yapılandırma, akış ve log'lar işleniyor (canlı Jira testi ATLANIYOR)…"
else
  info "Yapılandırma, akış ve CANLI JİRA denemesi çalıştırılıyor…"
  info "  (yalnız OKUMA — hiçbir yorum yazılmaz, hiçbir statü geçirilmez)"
fi

RC=0
if [[ "$JIRA_YOK" -eq 1 ]]; then
  docker compose run --rm -T \
    -e MAESTRO_ENTRYPOINT=apps/deploy/dist/bin/tani.js \
    migrate --jira-yok <"${TMP}/girdi.json" >"${TMP}/rapor.html" || RC=$?
else
  docker compose run --rm -T \
    -e MAESTRO_ENTRYPOINT=apps/deploy/dist/bin/tani.js \
    migrate <"${TMP}/girdi.json" >"${TMP}/rapor.html" || RC=$?
fi

# Boş bir HTML, bozuk bir HTML'den beterdir: tarayıcıda beyaz bir sayfa açılır
# ve operatör aracın çalıştığını sanır. Yazmadan önce bakıyoruz.
if [[ ! -s "${TMP}/rapor.html" ]]; then
  err "Rapor üretilemedi (çıkış kodu: ${RC}) — HTML boş."
  err "  Konteynerin ne dediğine bakın:  docker compose logs migrate"
  die "Tanı başarısız."
fi

cp "${TMP}/rapor.html" "$CIKTI"
echo

if [[ "$RC" -eq 3 ]]; then
  warn "Rapor hazır — ve KRİTİK bulgu var: ${CIKTI}"
  warn "  Sayfanın en üstündeki kırmızı satırlar, bu kurulumda sessizce"
  warn "  çalışmayan işleri ve çözümlerini gösteriyor."
elif [[ "$RC" -eq 0 ]]; then
  ok "Rapor hazır: ${CIKTI}"
  ok "  Yapılandırmada engelleyici sorun bulunmadı."
else
  warn "Rapor üretildi ama toplayıcı hata verdi (çıkış kodu: ${RC}): ${CIKTI}"
  warn "  Sayfa eksik olabilir. Ayrıntı için:  docker compose logs migrate"
fi

echo
info "Dosyayı tarayıcıda açabilir, yazdırabilir ya da destek için gönderebilirsiniz."
info "Göndermeden önce bir göz atın: sırlar maskelenir, ama bu en iyi çabadır."
