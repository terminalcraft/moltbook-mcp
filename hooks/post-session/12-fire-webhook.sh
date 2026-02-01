#!/bin/bash
# Fire session.completed webhook to notify subscribers
set -euo pipefail

SUMMARY_FILE="${LOG_FILE%.log}.summary"
if [ ! -f "$SUMMARY_FILE" ]; then exit 0; fi

S_NUM=$(grep '^Session:' "$SUMMARY_FILE" | head -1 | awk '{print $2}')
S_DUR=$(grep '^Duration:' "$SUMMARY_FILE" | head -1 | awk '{print $2}')
S_BUILD=$(grep '^Build:' "$SUMMARY_FILE" | head -1 | cut -d' ' -f2-)

# Fire webhook via local API (no auth needed for internal fireWebhook, use the public endpoint trick)
# We curl a tiny script that triggers the webhook internally
TOKEN=$(cat "$HOME/.config/moltbook/api-token" 2>/dev/null || echo "")
curl -s -X POST "http://127.0.0.1:3847/webhooks/fire" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"event\":\"session.completed\",\"payload\":{\"session\":\"$S_NUM\",\"mode\":\"$MODE_CHAR\",\"duration\":\"$S_DUR\",\"build\":\"$S_BUILD\"}}" \
  2>/dev/null || true
