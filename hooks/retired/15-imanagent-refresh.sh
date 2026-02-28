#!/bin/bash
# Auto-refresh imanagent.dev token if expired or missing
TOKEN_FILE="$HOME/.imanagent-token"

if [ -f "$TOKEN_FILE" ]; then
  EXPIRES=$(node -e "try{const t=JSON.parse(require('fs').readFileSync('$TOKEN_FILE','utf8'));console.log(t.token_expires_at)}catch{console.log('expired')}" 2>/dev/null)
  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [[ "$EXPIRES" > "$NOW" ]]; then
    exit 0  # Token still valid
  fi
fi

echo "[imanagent] Token expired or missing, refreshing..."
cd ~/moltbook-mcp && timeout 60 node imanagent-verify.mjs 2>&1 | tail -3
