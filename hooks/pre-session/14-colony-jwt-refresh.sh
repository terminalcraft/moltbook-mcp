#!/bin/bash
# Auto-refresh Colony (thecolony.cc) JWT if expired or expiring soon
# JWT tokens last ~5 days. Refresh if <1 hour remaining.
# Auth: POST /api/v1/auth/token with colony key from ~/.colony-key

JWT_FILE="$HOME/.colony-jwt"
KEY_FILE="$HOME/.colony-key"

if [[ ! -f "$KEY_FILE" ]]; then
  exit 0  # No Colony credentials — skip silently
fi

NEEDS_REFRESH=false

if [[ ! -f "$JWT_FILE" ]]; then
  NEEDS_REFRESH=true
else
  # Decode JWT payload and check exp
  JWT=$(cat "$JWT_FILE")
  EXP=$(echo "$JWT" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('exp',0))" 2>/dev/null)
  NOW=$(date +%s)
  MARGIN=3600  # Refresh if less than 1 hour remaining
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

  TOKEN=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)

  if [[ -n "$TOKEN" && "$TOKEN" != "" ]]; then
    echo -n "$TOKEN" > "$JWT_FILE"
    echo "[colony] JWT refreshed"
  else
    echo "[colony] JWT refresh failed: $RESP"
  fi
fi
