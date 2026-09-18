#!/usr/bin/env bash
#
# semgrep'in ÇEVRİMDIŞI kural setini tarama birimine yükler (6b, M27).
#
# Tarayıcı konteynerinin ağı yoktur; kuralları bu birimden, /rules altından
# okur. Kullanım (kurulum klasöründe):
#   ./tarama-kurallari-yukle.sh [kural-dosyası]
# Varsayılan dosya: tarama/semgrep-kurallar.yml (bu paketle gelir). Kurumun
# kendi kural seti varsa yolunu verin; dosya birime semgrep.yml adıyla kopyalanır.
# .env'de SCAN_RULES_VOLUME bu birimin adı, SCAN_SEMGREP_RULES=/rules/semgrep.yml olmalı.
set -euo pipefail
cd "$(dirname "$0")"
PROJE="$(grep -oE '^COMPOSE_PROJECT_NAME=.*' .env 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' ' || true)"
PROJE="${PROJE:-maestro}"
BIRIM="$(grep -oE '^SCAN_RULES_VOLUME=.*' .env 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' ' || true)"
BIRIM="${BIRIM:-${PROJE}_maestro-scan-rules}"
KAYNAK="${1:-tarama/semgrep-kurallar.yml}"
[ -f "$KAYNAK" ] || { echo "kural dosyası yok: $KAYNAK" >&2; exit 1; }
YARDIMCI="$(grep -oE '^MAESTRO_NODE_IMAGE=.*' .env 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' ' || true)"
YARDIMCI="${YARDIMCI:-alpine:3.20}"
docker volume create "$BIRIM" >/dev/null
docker run --rm --entrypoint sh \
  -v "$BIRIM":/rules \
  -v "$(cd "$(dirname "$KAYNAK")" && pwd)/$(basename "$KAYNAK")":/kaynak.yml:ro \
  "$YARDIMCI" -c 'cp /kaynak.yml /rules/semgrep.yml && chmod 0644 /rules/semgrep.yml && ls -l /rules'
echo "[maestro] semgrep kuralları yüklendi → birim: $BIRIM, dosya: /rules/semgrep.yml"
echo "[maestro] .env: SCAN_RULES_VOLUME=\"$BIRIM\"  SCAN_SEMGREP_RULES=\"/rules/semgrep.yml\""
