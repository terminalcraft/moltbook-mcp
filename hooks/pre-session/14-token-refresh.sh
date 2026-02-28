#!/bin/bash
# Auto-refresh short-lived tokens: Colony JWT and imanagent.dev
# Consolidated from 14-colony-jwt-refresh.sh + 15-imanagent-refresh.sh (d070, wq-743)

set -euo pipefail
DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# --- Colony JWT ---
# JWT tokens last ~5 days. Refresh if <1 hour remaining.
JWT_FILE="$HOME/.colony-jwt"
KEY_FILE="$HOME/.colony-key"

if [[ -f "$KEY_FILE" ]]; then
  NEEDS_REFRESH=false
  if [[ ! -f "$JWT_FILE" ]]; then
    NEEDS_REFRESH=true
  else
    JWT=$(cat "$JWT_FILE")
    EXP=$(echo "$JWT" | cut -d. -f2 | base64 -d 2>/dev/null | jq -r '.exp // 0' 2>/dev/null)
    NOW=$(date +%s)
    MARGIN=3600
    if [[ -z "$EXP" ]] || [[ "$EXP" -lt $((NOW + MARGIN)) ]]; then
      NEEDS_REFRESH=true
    fi
  fi

  if [[ "$NEEDS_REFRESH" == "true" ]]; then
    COL_CRED=$(cat "$KEY_FILE")
    RESP=$(curl -s --max-time 8 "https://thecolony.cc/api/v1/auth/token" \
      -X POST \
      -H "Content-Type: application/json" \
      -d "{\"api_key\":\"$COL_CRED\"}" 2>/dev/null)
    TOKEN=$(echo "$RESP" | jq -r '.access_token // empty' 2>/dev/null)
    if [[ -n "$TOKEN" && "$TOKEN" != "" ]]; then
      echo -n "$TOKEN" > "$JWT_FILE"
      echo "[token-refresh] Colony JWT refreshed"
    else
      echo "[token-refresh] Colony JWT refresh failed: $RESP"
    fi
  fi
fi

# --- imanagent.dev ---
TOKEN_FILE="$HOME/.imanagent-token"

if [ -f "$TOKEN_FILE" ]; then
  EXPIRES=$(node -e "try{const t=JSON.parse(require('fs').readFileSync('$TOKEN_FILE','utf8'));console.log(t.token_expires_at)}catch{console.log('expired')}" 2>/dev/null)
  NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [[ "$EXPIRES" > "$NOW_ISO" ]]; then
    exit 0  # Both tokens valid
  fi
fi

if [ -f "$DIR/imanagent-verify.mjs" ]; then
  echo "[token-refresh] imanagent token expired or missing, refreshing..."
  cd "$DIR" && timeout 60 node imanagent-verify.mjs 2>&1 | tail -3
fi
