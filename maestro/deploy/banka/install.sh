#!/usr/bin/env bash
# =============================================================================
# Maestro — banka içi (internetsiz) kurulum
# BUNDLE_VERSION: 2026-08-16
# =============================================================================
# Kullanım (bu klasörde):
#   ./install.sh          # interaktif
#   ./install.sh --yes    # sorusuz (otomasyon için)
#
# Ön koşul: docker + compose v2 kurulu, imajlar `docker load` ile yüklenmiş,
#           .env doldurulmuş.
#
# Bu betik İNTERNETE ÇIKMAZ. Hiçbir adımı imaj indirmez, sürüm sorgulamaz,
# telemetri göndermez — banka sunucusunun dışarıya yolu yoktur.
#
# TASARIM: bu betik yalnızca "çalıştıran" değil, ÖNCE DOĞRULAYAN bir betiktir.
# Buradaki her kontrol, sahada bir kez sessizce başarısız olmuş bir kurulumun
# karşılığıdır. Sessiz arıza — açılan ama hiçbir şey yapmayan bir sistem —
# gürültülü arızadan pahalıdır, bu yüzden hepsi erken ve yüksek sesle düşer.
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

BUNDLE_VERSION="2026-08-16"

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
echo "  Paket sürümü: ${BUNDLE_VERSION}"
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

# Betiğin kendi sürümü, .env okunmadan ÖNCE saklanır: `. ./.env` aynı adlı
# değişkeni ezer ve karşılaştırma anlamsızlaşırdı.
BUNDLE_VERSION_SCRIPT="${BUNDLE_VERSION}"

# shellcheck disable=SC1091
set -a; . ./.env; set +a

# Paket ile .env aynı sürümden mi? Farklıysa büyük ihtimalle eski bir kurulumun
# .env'i yeni bir paketin üstüne kopyalanmıştır — yeni zorunlu alanlar eksik olur.
# `. ./.env` yukarıda BUNDLE_VERSION'ı .env'deki değerle EZDİ; bu yüzden dosyadan
# ayrıca okunur ve betiğin kendi sürümüyle karşılaştırılır.
DOTENV_VERSION=$(grep -E '^BUNDLE_VERSION=' .env | head -1 | cut -d= -f2- | tr -d '"' || true)
if [[ -n "${DOTENV_VERSION:-}" && "${DOTENV_VERSION}" != "${BUNDLE_VERSION_SCRIPT}" ]]; then
  warn ".env sürümü (${DOTENV_VERSION}) paket sürümünden (${BUNDLE_VERSION_SCRIPT}) farklı."
  warn "  Eski bir .env yeni pakete kopyalanmışsa yeni ZORUNLU alanlar eksik olabilir."
  warn "  .env.example ile karşılaştırın:  diff <(grep -oE '^[A-Z_]+=' .env.example) <(grep -oE '^[A-Z_]+=' .env)"
  onay "Yine de devam edilsin mi?" || exit 0
fi

# Doldurulmamış alanlar
if grep -q "DEGISTIR" .env; then
  err ".env içinde DEGISTIR kalmış — doldurulmamış alan var:"
  grep -n "DEGISTIR" .env | sed 's/^/    /'
  die "Bu alanları doldurup tekrar çalıştırın."
fi
ok "Doldurulmamış alan yok."

# ── 3) ZORUNLU değişkenler dolu mu ───────────────────────────────────────────
# Boş bırakılınca sistemin AÇILIP HİÇBİR ŞEY YAPMADIĞI değişkenler. Her biri
# ayrı ayrı kontrol edilir ki hata mesajı hangisinin eksik olduğunu söylesin.
info "Zorunlu değişkenler…"
ZORUNLU=(
  MAESTRO_NODE_IMAGE MAESTRO_STUDIO_IMAGE POSTGRES_IMAGE REDIS_IMAGE TEMPORAL_IMAGE
  MAESTRO_PROFILE NODE_ENV
  CONNECTOR_MASTER_KEY
  POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB REDIS_PASSWORD
  WORK_DRIVER JIRA_BASE_URL
  MAESTRO_BOT_ACCOUNT_ID MAESTRO_BOT_EMAIL
  LLM_BASE_URL LLM_MODEL LLM_ON_PREM
  MAESTRO_SECRET_KV_JIRA__TOKEN MAESTRO_SECRET_KV_LLM__API__2D_KEY
  JIRA_TOKEN_REF LLM_API_KEY_REF
  STUDIO_PORT
)
EKSIK_VAR=()
for v in "${ZORUNLU[@]}"; do
  [[ -n "${!v:-}" ]] || EKSIK_VAR+=("$v")
done
if [[ ${#EKSIK_VAR[@]} -gt 0 ]]; then
  err "Şu ZORUNLU değişkenler boş:"
  for v in "${EKSIK_VAR[@]}"; do err "    ${v}"; done
  die ".env dosyasını doldurup tekrar çalıştırın."
fi
ok "Zorunlu değişkenlerin hepsi dolu."

# ── 4) Profil / NODE_ENV eşleşmesi ───────────────────────────────────────────
# En pahalı sessiz arızalardan biri: `analiz` profili sırları env-file
# sürücüsüyle okur, o sürücü ise NODE_ENV=production altında yapıcısında
# reddeder (M6/M80). İkisi uyumsuzsa sistem hiç açılmaz — ama log'a bakmayan
# biri için "kurulum bitti" görünür.
info "Profil tutarlılığı…"
case "${MAESTRO_PROFILE}" in
  analiz)
    if [[ "${NODE_ENV}" == "production" ]]; then
      err "MAESTRO_PROFILE=analiz ile NODE_ENV=production birlikte ÇALIŞMAZ."
      err "  'analiz' profili sırları env-file sürücüsüyle okur; o sürücü"
      err "  NODE_ENV=production altında açılmayı reddeder (M6/M80)."
      die "NODE_ENV=development yapın ya da Vault kurup MAESTRO_PROFILE=prod'a geçin."
    fi
    ok "Profil: analiz (sahaya çıkan sürüm)."
    ;;
  prod)
    [[ "${NODE_ENV}" == "production" ]] \
      || die "MAESTRO_PROFILE=prod ise NODE_ENV=production olmalıdır."
    # prod profili Vault + S3 + ADO ister; biri eksikse süreç açılışta ölür.
    for v in VAULT_ADDR VAULT_ROLE_ID VAULT_SECRET_ID STORAGE_ENDPOINT \
             ADO_BASE_URL ADO_ORG ADO_PROJECT ADO_PR_VALIDATION_BUILDS; do
      [[ -n "${!v:-}" ]] || die "MAESTRO_PROFILE=prod ama ${v} boş. 'prod' profili Vault + S3 + Azure DevOps ister."
    done
    ok "Profil: prod (Vault + S3 + ADO doğrulandı)."
    ;;
  dev)
    die "MAESTRO_PROFILE=dev sahte sürücüler kullanır — banka kurulumunda kullanılmaz."
    ;;
  *)
    die "MAESTRO_PROFILE='${MAESTRO_PROFILE}' geçersiz. Beklenen: analiz, prod."
    ;;
esac

# ── 5) Motorun Jira kimliği ──────────────────────────────────────────────────
# Bu boşsa keşif `assignee = currentUser()` ile çalışır: jetonun sahibi kimse
# onun talepleri işlenir. Panelden kurulan dinleme kuralları ise başka bir
# kimliğe bakar ve HİÇ EŞLEŞMEZ — hiçbir yerde hata görünmeden.
info "Motor kimliği…"
[[ -n "${MAESTRO_BOT_ACCOUNT_ID:-}" ]] \
  || die "MAESTRO_BOT_ACCOUNT_ID boş. Bu hâlde dinleme kuralları sessizce hiçbir talebi yakalamaz."
if [[ "${MAESTRO_BOT_ACCOUNT_ID}" =~ [@] ]]; then
  err "MAESTRO_BOT_ACCOUNT_ID bir e-posta gibi görünüyor: ${MAESTRO_BOT_ACCOUNT_ID}"
  err "  Beklenen: Jira Cloud accountId (profil adresindeki son parça),"
  err "  Data Center'da ise kullanıcı adı. E-posta MAESTRO_BOT_EMAIL'e yazılır."
  die "MAESTRO_BOT_ACCOUNT_ID düzeltilmeli."
fi
ok "MAESTRO_BOT_ACCOUNT_ID dolu."
warn "Kurulumdan sonra DOĞRULAYIN: panelde Ayarlar > Bağlantılar > test, bu kimlikle"
warn "  bağlantının kimliği AYNI olmalı. Farklıysa panel uyarır ve kurallar boş döner."

# ── 6) Sır adları elle yazılmış mı ───────────────────────────────────────────
# Sürücü değişken adını referanstan TÜRETİR (kv/jira#token →
# MAESTRO_SECRET_KV_JIRA__TOKEN, '#' çift alt çizgi). Eski paketlerdeki
# elle yazılmış adlar hiç aranmıyordu: sürücü "secret not found" derken
# operatör .env'de değeri dolu görüyordu.
info "Sır değişken adları…"
for eski in MAESTRO_SECRET_JIRA_TOKEN MAESTRO_SECRET_ADO_TOKEN \
            MAESTRO_SECRET_LLM_API_KEY MAESTRO_SECRET_LDAP_BIND_PASSWORD; do
  if grep -qE "^${eski}=" .env 2>/dev/null; then
    err ".env içinde ESKİ sır değişkeni var: ${eski}"
    err "  Bu adı hiçbir sürücü aramaz. Doğru adlar referanstan türetilir:"
    err "    kv/jira#token  →  MAESTRO_SECRET_KV_JIRA__TOKEN   ('#' ÇİFT alt çizgi)"
    err "    kv/llm#api-key →  MAESTRO_SECRET_KV_LLM__API__2D_KEY  ('-' → __2D_)"
    die ".env.example'daki adları kullanın."
  fi
done
# Referans biçimi: <mount>/<yol>[#alan] — en az bir '/' içermeli.
for refvar in JIRA_TOKEN_REF LLM_API_KEY_REF JIRA_WEBHOOK_SECRET_REF; do
  val="${!refvar:-}"
  [[ -z "$val" ]] && continue
  if [[ "$val" != */* ]]; then
    err "${refvar}='${val}' geçersiz."
    err "  Beklenen biçim: <mount>/<yol>[#alan]  örn. kv/jira#token"
    err "  'env:JIRA_TOKEN' gibi bir değer ayrıştırılamaz ve açılışta SecretKeyError verir."
    die "${refvar} düzeltilmeli."
  fi
done
ok "Sır adları ve referans biçimleri doğru."

# CONNECTOR_MASTER_KEY tam 32 bayt (base64) olmalı; değilse BFF açılışta ölür.
KEY_BYTES=$(printf '%s' "${CONNECTOR_MASTER_KEY}" | base64 -d 2>/dev/null | wc -c || echo 0)
if [[ "${KEY_BYTES}" -ne 32 ]]; then
  err "CONNECTOR_MASTER_KEY base64 çözüldüğünde 32 bayt olmalı, ${KEY_BYTES} bayt çıktı."
  err "  Üretmek için:  openssl rand -base64 32"
  die "CONNECTOR_MASTER_KEY düzeltilmeli."
fi
ok "CONNECTOR_MASTER_KEY geçerli (32 bayt)."

# ── 7) Sık yapılan yapılandırma hataları ─────────────────────────────────────
info "Yapılandırma tutarlılığı…"

# LLM_BASE_URL sonunda /v1 → sürücü de ekler → /v1/v1 → her çağrı 404
if [[ "${LLM_BASE_URL:-}" =~ /v1/?$ ]]; then
  err "LLM_BASE_URL sonunda '/v1' var: ${LLM_BASE_URL}"
  err "  Sürücü '/v1/chat/completions' ekler; bu hâliyle '/v1/v1/...' olur ve"
  err "  her model çağrısı 404 döner. Sondaki '/v1' kısmını silin."
  die "LLM_BASE_URL düzeltilmeli."
fi

# Kurum içi endpoint ama on-prem bayrağı kapalı → gizli işler bozularak biter
if [[ "${LLM_ON_PREM:-}" != "true" ]]; then
  warn "LLM_ON_PREM='${LLM_ON_PREM:-}' — 'true' değil."
  warn "  Bu hâlde 'gizli' sınıflı işlerde on-prem model YOK sayılır; analiz"
  warn "  'elle tamamlayın' diye bozularak biter — hata değil, eksik çıktı."
  onay "Bilerek mi böyle?" || die "LLM_ON_PREM=true yapın."
fi

# BFF_PORT artık .env'den OKUNMAZ; compose onu 7001'de sabitler. Eski bir
# .env'de kalmış olabilir ve orada durduğu sürece operatör onu değiştirilebilir
# sanır. Değiştirdiğinde de yığın açılmaz: 7001 sayısı compose'daki
# healthcheck'te ve studio-nginx.conf'taki proxy_pass satırında SABİTTİR, süreç
# ise başka bir portu dinlemeye başlar. Bu yüzden 7001 dışında bir değer
# gördüğümüzde sessizce yok saymak yerine durup söylüyoruz — yok saysaydık
# operatör ayarın işe yaradığını sanmaya devam ederdi.
if [[ -n "${BFF_PORT:-}" && "${BFF_PORT}" != "7001" ]]; then
  err ".env içinde BFF_PORT='${BFF_PORT}' var; bu ayar artık KULLANILMIYOR."
  err "  BFF'in konteyner içindeki portu 7001'de sabittir (compose yazar) ve"
  err "  aynı sayı healthcheck ile studio-nginx.conf'ta da sabit durur. Bu"
  err "  satır dosyada kaldığı sürece değiştirilebilir görünür; değiştirildiği"
  err "  anda bff hiç 'healthy' olmaz ve studio hiç başlamaz."
  err "  Panelin dışarıya açıldığı portu değiştirmek için STUDIO_PORT kullanın."
  die ".env'den BFF_PORT satırını silin."
fi

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

# LDAP seçiliyse KODUN OKUDUĞU alanlar dolu mu.
# Dikkat: LDAP_USER_BASE_DN. Eski paketlerde `LDAP_BASE_DN` yazıyordu ve o adı
# hiçbir şema okumuyordu — LDAP dolu görünüp hiç çalışmıyordu.
if [[ "${IDENTITY_DRIVER:-}" == "ldaps-bind" ]]; then
  for v in LDAP_URL LDAP_USER_BASE_DN LDAP_BIND_DN; do
    [[ -n "${!v:-}" ]] || die "IDENTITY_DRIVER=ldaps-bind ama ${v} boş."
  done
  [[ "${LDAP_URL}" == ldaps://* ]] \
    || die "LDAP_URL 'ldaps://' ile başlamalı — düz ldap:// parolayı açık metin gönderir."
  [[ -n "${MAESTRO_SECRET_KV_LDAP__SERVICE__2D_PASSWORD:-}" ]] \
    || die "IDENTITY_DRIVER=ldaps-bind ama MAESTRO_SECRET_KV_LDAP__SERVICE__2D_PASSWORD boş."
  ok "LDAP alanları dolu."
fi
ok "Yapılandırma tutarlı."

# ── 8) İmajlar yerelde mi ────────────────────────────────────────────────────
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

# `latest` etiketi geri almayı imkânsızlaştırır.
for img in "${MAESTRO_NODE_IMAGE}" "${MAESTRO_STUDIO_IMAGE}"; do
  [[ "$img" == *:latest || "$img" != *:* ]] && \
    warn "  ${img} — 'latest' etiketi: hangi sürümün kurulu olduğu belirsizleşir, geri alma zorlaşır."
done

# ── 9) İmaj sağlığı (bayat/bozuk imaj erken yakalansın) ──────────────────────
info "İmaj doğrulanıyor…"
if docker run --rm --entrypoint sh "${MAESTRO_NODE_IMAGE}" -c "openssl version" >/dev/null 2>&1; then
  ok "  OpenSSL kurulu (Prisma query engine için gerekli)."
else
  warn "  İmajda OpenSSL YOK. Prisma sürüm tahmini yapar; sorun çıkarsa"
  warn "  imajı yeniden build edin (README §1.3)."
fi

MIG_SAYI=$(docker run --rm --entrypoint sh "${MAESTRO_NODE_IMAGE}" \
  -c "ls /app/packages/db/prisma/migrations 2>/dev/null | grep -c '^[0-9]'" 2>/dev/null || echo 0)
# Bu paketin beklediği asgari migration KLASÖRÜ sayısı. Son migration 0020'dir
# ama klasör sayısı 21'dir: iki klasör 0011 önekini paylaşır
# (0011_failed_run_is_terminal, 0011_listening_rules). Sayıyı en yüksek
# öneke bakarak tahmin etmek bu yüzden yanlış olur.
#
# İmaj bundan azını taşıyorsa eski bir koddan build edilmiştir: şema eksik
# kurulur ve eksik bir sütuna yazan kod hata vermeden çalışır — değer hiç
# veritabanına ulaşmaz.
MIG_BEKLENEN=21
if [[ "${MIG_SAYI}" -ge "${MIG_BEKLENEN}" ]]; then
  ok "  Migration dosyası: ${MIG_SAYI} adet (asgari ${MIG_BEKLENEN})."
else
  err "  İmajda ${MIG_SAYI} migration var, en az ${MIG_BEKLENEN} bekleniyordu."
  err "  İmaj ESKİ koddan build edilmiş. Eksik şemayla açılan sistem, yeni"
  err "  sütunlara yazarken hata vermez — veri sessizce kaybolur."
  die "Güncel koddan yeniden build edin."
fi

# Prisma istemcisi imajda üretilmiş mi. Üretilmemiş/bayat bir istemci yeni
# sütunu yok sayar: kod tip denetiminden geçer, yazar, değer Postgres'e HİÇ
# ULAŞMAZ. Bugüne kadar iki kez tam olarak bu yaşandı.
# pnpm, üretilen istemciyi `.pnpm` deposunun içine koyar; yol sürüm etiketini
# taşıdığı için sabit yazılamaz. Bu yüzden yol tahmin edilmez, ARANIR.
if docker run --rm --entrypoint sh "${MAESTRO_NODE_IMAGE}" \
     -c "find /app -path '*/.prisma/client/index.js' -print -quit 2>/dev/null | grep -q ." >/dev/null 2>&1; then
  ok "  Prisma istemcisi imajda üretilmiş."
else
  err "  Prisma istemcisi imajda YOK."
  err "  Bu hâlde yeni sütunlara yazan kod hata vermeden çalışır ve değer"
  err "  veritabanına hiç ulaşmaz. İmaj kullanılamaz."
  die "İmajı yeniden build edin (Dockerfile.node 'prisma generate' adımını içerir)."
fi

# ── 10) Compose doğrula ──────────────────────────────────────────────────────
info "Compose doğrulanıyor…"
docker compose config >/dev/null || die "compose config HATALI (.env eksik/yanlış?)."
ok "Compose geçerli."

# ── 10b) ORTAM ÖN DOĞRULAMASI — şemanın kendisiyle ───────────────────────────
# Yukarıdaki 9 adım 24 değişkeni tek tek kontrol eder ve YİNE DE açılamayan bir
# yığını geçirdi. Sebep, listenin eksik olması değil — YÖNTEMİN eksik olması:
# betik "hangi değişkenler önemli" sorusunu ELLE yanıtlıyor, süreç ise bunu
# `packages/config`'teki şemadan öğreniyor. İki liste ayrı yerlerde durduğu
# sürece ayrışırlar, ve ayrıştıkları gün fark ediliş biçimi budur: 24 yeşil
# tik, ardından `migrate` konteynerinin tek satırlık ölümü.
#
# Somut olay: compose `ADO_BASE_URL: ${ADO_BASE_URL:-}` satırıyla değişkeni
# İLETİR, .env'de ise değişken hiç yoktur. Compose'un "tanımsız" diye bir
# aktarımı yoktur; süreç değeri BOŞ DİZE olarak alır. Şema o gün boş dizeyi
# reddediyordu ve dört ayrı `Invalid URL` satırı, operatörün hiç duymadığı dört
# değişkeni suçluyordu. Şema düzeltildi (boş = yok), ama düzeltilen tek bir
# arızaydı; buradaki kontrol arıza SINIFINI kapatır.
#
# Yöntem: değişken adı SAYMAK yerine, konteynerin gerçekten göreceği ortamı
# şemanın KENDİSİNE doğrulatmak. `docker compose run` ile bff servisinin ortamı
# aynen kurulur — compose ne iletiyorsa o, boş dizeler dahil — ve içeride
# `loadDeployEnv` çağrılır. Bu, açılışta çalışan doğrulamanın ta kendisidir.
# Dolayısıyla burada geçen bir ortam açılışta da geçer, ve buradaki liste asla
# bayatlayamaz: liste yoktur, şema vardır.
#
# Hiçbir servise, veritabanına ya da ağa dokunmaz: yalnızca ortamı okur.
info "Ortam, uygulamanın kendi şemasıyla ön doğrulamadan geçiriliyor…"
ONDOGRULAMA='
import { loadDeployEnv } from "./src/env.ts";
try {
  loadDeployEnv();
  console.log("ORTAM_GECERLI");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
'
if ! ONDOGRULAMA_CIKTI=$(docker compose run --rm --no-deps \
      --entrypoint sh bff -c \
      "cd apps/deploy && node --import tsx --input-type=module -e '${ONDOGRULAMA}'" 2>&1); then
  err "Ortam doğrulaması BAŞARISIZ — bu yığın açılamaz."
  printf '%s\n' "${ONDOGRULAMA_CIKTI}" | sed 's/^/    /' >&2
  err ""
  err "Bu, uygulamanın açılışta yaptığı doğrulamanın aynısıdır; şimdi başarısız"
  err "olması, 'migrate' konteynerinin birazdan aynı hatayla ölmesi demektir."
  err ""
  err "En sık sebebi: compose'un ilettiği bir değişken .env'de HİÇ YOKTUR."
  err "  Compose \${DEGISKEN:-} yazan her satırı BOŞ DİZE olarak iletir; şema"
  err "  bazı alanlarda boş dizeyi 'yok' saymaz. Yukarıda adı geçen her"
  err "  değişkeni .env'de ya doğru değerle doldurun ya da tamamen silin."
  die "Ortamı düzeltip tekrar çalıştırın."
fi
ok "Ortam şemaya uygun (uygulamanın açılış doğrulaması geçildi)."

# ── 11) Başlat ───────────────────────────────────────────────────────────────
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

# ── 12) Sağlık ───────────────────────────────────────────────────────────────
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
echo "  Giriş   : admin / admin123   ← İLK İŞİNİZ BUNU DEĞİŞTİRMEK"
echo "  Loglar  : docker compose logs -f bff"
echo "  Durum   : docker compose ps"
echo "  Yedek   : docker compose exec -T postgres pg_dump -U ${POSTGRES_USER} ${POSTGRES_DB} | gzip > yedek.sql.gz"
echo
warn "KURULUM BİTMEDİ — README.md 'Kurulumdan sonra mutlaka yapın' bölümünü uygulayın:"
warn "  1) admin/admin123 parolasını değiştirin"
warn "  2) bot hesabı 'maestro-admins' grubunda OLMASIN (tek başına dört-göz kuralını geçer)"
warn "  3) Jira webhook'unu kaydedin (docs/jira-webhook-kurulum.md)"
warn "  4) MAESTRO_BOT_ACCOUNT_ID ile bağlantının kimliği AYNI mı, panelden doğrulayın"
echo
warn "ASLA 'docker compose down -v' çalıştırmayın — veritabanını siler."
