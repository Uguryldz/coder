#!/usr/bin/env bash
# =============================================================================
# Maestro — analiz şablonunu (9 bölüm, PDD düzeni) ve kurumsal Word şablonunu
# çalışan kuruluma yayınlar.
# =============================================================================
# Kullanım (kurulum klasöründe, docker-compose.yml'in yanında):
#   ./sablon/analiz-sablonu-yayinla.sh                 # ikisini de yayınlar
#   ./sablon/analiz-sablonu-yayinla.sh --sadece-analiz # yalnız bölüm şablonu
#   ./sablon/analiz-sablonu-yayinla.sh --sadece-word   # yalnız .docx
#
# Ne yapar:
#   1) Studio yönetici hesabıyla BFF'e giriş yapar (kullanıcı adı/parola sorar,
#      parola ekranda görünmez, hiçbir yere yazılmaz).
#   2) İmajın İÇİNDEKİ varsayılan analiz şablonunu (packages/db/dist/
#      template-defaults.js — motor iskeletiyle sıralı 9 bölüm) yeni bir SÜRÜM
#      olarak yayınlar (POST /template/versions). Sürümler yalnız-ekleme:
#      eski sürüm silinmez, çalışan işler başladıkları sürümle biter.
#   3) HFKB-Analiz-Sablonu.docx dosyasını kurumsal Word şablonu olarak yükler
#      (POST /doc-template). Bir sonraki analiz belgesi bu şablonla üretilir.
#
# Aynı işi Studio'dan elle de yapabilirsiniz: Analiz şablonu → bölümleri düzenle
# → "Yeni sürüm olarak yayınla"; Word şablonu → "Şablon yükle (.docx)".
# Bu betik yalnız 9 bölümü tek tek yazma zahmetini kaldırır.
#
# BFF'e konteynerin İÇİNDEN (127.0.0.1:7001) ulaşılır: 7001 dışa açık değildir
# (docker-compose.yml, bff servisi), ve imajda curl yoktur — node kullanılır.
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
err()  { printf '\033[31m✘\033[0m %s\n' "$*" >&2; }
info() { printf '\033[36m→\033[0m %s\n' "$*"; }
die()  { err "$*"; exit 1; }

MOD="${1:-}"
YAYINLA_ANALIZ=1; YAYINLA_WORD=1
case "$MOD" in
  "") ;;
  --sadece-analiz) YAYINLA_WORD=0 ;;
  --sadece-word) YAYINLA_ANALIZ=0 ;;
  *) echo "Kullanım: $0 [--sadece-analiz | --sadece-word]"; exit 0 ;;
esac

DOCX="sablon/HFKB-Analiz-Sablonu.docx"
command -v docker >/dev/null || die "docker bulunamadı"
docker compose ps --format '{{.Service}} {{.Status}}' 2>/dev/null | grep -q "^bff.*healthy" \
  || die "bff sağlıklı değil — önce kurulumu ayağa kaldırın: docker compose ps"
[[ $YAYINLA_WORD -eq 1 && ! -f "$DOCX" ]] && die "$DOCX yok"

read -r -p "Studio yönetici kullanıcı adı [admin]: " KULLANICI; KULLANICI="${KULLANICI:-admin}"
read -r -s -p "Parola: " PAROLA; echo
[[ -n "$PAROLA" ]] || die "parola boş"

if [[ $YAYINLA_WORD -eq 1 ]]; then
  docker compose cp "$DOCX" bff:/tmp/HFKB-Analiz-Sablonu.docx >/dev/null
fi

# Parola ortam değişkeniyle konteynere geçer; komut satırında ve loglarda görünmez.
docker compose exec -T \
  -e MAESTRO_PUB_USER="$KULLANICI" -e MAESTRO_PUB_PASS="$PAROLA" \
  -e MAESTRO_PUB_ANALIZ="$YAYINLA_ANALIZ" -e MAESTRO_PUB_WORD="$YAYINLA_WORD" \
  bff node --input-type=module -e '
const base = "http://127.0.0.1:7001";
const { MAESTRO_PUB_USER: user, MAESTRO_PUB_PASS: pass } = process.env;
const login = await fetch(base + "/auth/login", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: user, password: pass }) });
if (!login.ok) { console.error("✘ giriş başarısız: HTTP " + login.status); process.exit(1); }
const { token } = await login.json();
const auth = { authorization: "Bearer " + token };

if (process.env.MAESTRO_PUB_ANALIZ === "1") {
  const defaults = await import("/app/packages/db/dist/template-defaults.js");
  const body = { name: defaults.DEFAULT_ANALYSIS_TEMPLATE_NAME, sections: defaults.DEFAULT_ANALYSIS_TEMPLATE_SECTIONS };
  const r = await fetch(base + "/template/versions", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) { console.error("✘ analiz şablonu yayınlanamadı: HTTP " + r.status + " " + text.slice(0, 300)); process.exit(1); }
  const v = (() => { try { return JSON.parse(text).version; } catch { return "?"; } })();
  console.log("✔ analiz şablonu yayınlandı: sürüm " + v + " — " + body.sections.length + " bölüm (" + body.name + ")");
}

if (process.env.MAESTRO_PUB_WORD === "1") {
  const { readFileSync } = await import("node:fs");
  const bytes = readFileSync("/tmp/HFKB-Analiz-Sablonu.docx");
  const r = await fetch(base + "/doc-template", { method: "POST", headers: { ...auth,
    "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "x-maestro-filename": "HFKB-Analiz-Sablonu.docx" }, body: bytes });
  const text = await r.text();
  if (!r.ok) { console.error("✘ Word şablonu yüklenemedi: HTTP " + r.status + " " + text.slice(0, 300)); process.exit(1); }
  const view = JSON.parse(text);
  const missing = (view.placeholders ?? []).filter((p) => !p.found).map((p) => p.token);
  const mapped = (view.sectionMapping ?? []).filter((m) => m.mapped).length;
  console.log("✔ Word şablonu yüklendi: sürüm " + view.template?.version + " — bölüm eşlemesi " + mapped + "/" + (view.sectionMapping ?? []).length);
  if (missing.length) console.log("  şablonda olmayan yer tutucular (bilgi): " + missing.join(", "));
}
'
[[ $YAYINLA_WORD -eq 1 ]] && docker compose exec -T bff rm -f /tmp/HFKB-Analiz-Sablonu.docx >/dev/null 2>&1 || true
ok "bitti — Studio › Analiz şablonu ve Word şablonu ekranlarından doğrulayabilirsiniz"
