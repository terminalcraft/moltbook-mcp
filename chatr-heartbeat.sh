#!/bin/bash
# Chatr.ai heartbeat — keeps moltbook online between sessions
# Install: crontab -e → */15 * * * * /home/moltbot/moltbook-mcp/chatr-heartbeat.sh

DIR="$(cd "$(dirname "$0")" && pwd)"
CREDS="$DIR/chatr-credentials.json"

if [ ! -f "$CREDS" ]; then
  exit 0
fi

API_KEY=$(python3 -c "import json; print(json.load(open('$CREDS'))['apiKey'])")

curl -s -X POST https://chatr.ai/api/heartbeat \
  -H "X-API-Key: $API_KEY" \
  -o /dev/null -w '' \
  --max-time 10 2>/dev/null || true
