#!/usr/bin/env bash
# ============================================================================
#  Sahte Jira webhook → API'ye gönderir. Workflow başlatmayı test eder.
# ============================================================================
set -euo pipefail

API="${API:-http://localhost:7001}"
TICKET_KEY="${1:-TEST-$(date +%s)}"
SECRET="${JIRA_WEBHOOK_SECRET:-change-me}"

# 1. issue_created — workflow başlat
PAYLOAD=$(cat <<EOF
{
  "webhookEvent": "jira:issue_created",
  "issue": {
    "id": "${TICKET_KEY}",
    "key": "${TICKET_KEY}",
    "fields": {
      "project": {"key": "TEST"},
      "summary": "Sepet sayfasına indirim kuponu butonu ekle",
      "description": "Kullanıcı sepet ekranında 'Kupon kodu' girebilmeli, geçerli kodda indirim uygulanmalı.",
      "issuetype": {"name": "Task"},
      "labels": ["mode:full-auto"],
      "components": [{"name": "web"}]
    }
  }
}
EOF
)
SIG=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

echo "→ POST $API/webhooks/jira (issue_created, ticket=$TICKET_KEY)"
curl -fsS -X POST "$API/webhooks/jira" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature: sha256=$SIG" \
  -d "$PAYLOAD" && echo " ✓"

echo ""
echo "Workflow başlatıldı. İzlemek için:"
echo "  Temporal UI: http://localhost:8233  → ticket-${TICKET_KEY}"
echo "  Studio:      http://localhost:7000/workflows"
echo ""
echo "Onay göndermek için (PO):"
echo "  ./scripts/test-webhook.sh approve ${TICKET_KEY}"
