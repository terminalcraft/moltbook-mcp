#!/bin/bash
# Auto-refresh short-lived tokens: Colony JWT and imanagent.dev
# Consolidated from 14-colony-jwt-refresh.sh + 15-imanagent-refresh.sh (d070, wq-743)
# R#354: Added circuit-breaker awareness — skip refresh for circuit-broken platforms
# R#358: Made each refresh block non-fatal — one platform's failure doesn't block another
# wq-1003: Parallelized with timeout-wrapper, reduced curl/node timeouts to cap P95 <3000ms

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HOOKS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CIRCUITS_FILE="$DIR/platform-circuits.json"

# Source timeout-wrapper library for parallel execution + watchdog
source "$HOOKS_DIR/lib/timeout-wrapper.sh"

HOOK_TIMEOUT=4
CHECK_TIMEOUT=3

# Helper: check if a platform is circuit-broken (consecutive_failures >= threshold)
is_circuit_open() {
  local platform="$1"
  local threshold=3
  if [[ ! -f "$CIRCUITS_FILE" ]]; then
    return 1  # No circuits file → not open
  fi
  local failures
  failures=$(jq -r --arg p "$platform" '.[$p].consecutive_failures // 0' "$CIRCUITS_FILE" 2>/dev/null) || return 1
  [[ "$failures" -ge "$threshold" ]]
}

# --- Colony JWT ---
# JWT tokens last ~5 days. Refresh if <1 hour remaining.
tw_run "colony-jwt" bash -c '
  JWT_FILE="$HOME/.colony-jwt"
  KEY_FILE="$HOME/.colony-key"

  if [[ ! -f "$KEY_FILE" ]]; then
    exit 0
  fi

  # Circuit-breaker check
  CIRCUITS_FILE="'"$CIRCUITS_FILE"'"
  if [[ -f "$CIRCUITS_FILE" ]]; then
    failures=$(jq -r ".thecolony.consecutive_failures // 0" "$CIRCUITS_FILE" 2>/dev/null) || failures=0
    [[ "$failures" -ge 3 ]] && echo "[token-refresh] Colony circuit-broken, skipping" && exit 0
  fi

  NEEDS_REFRESH=false
  if [[ ! -f "$JWT_FILE" ]]; then
    NEEDS_REFRESH=true
  else
    JWT=$(cat "$JWT_FILE")
    EXP=$(echo "$JWT" | cut -d. -f2 | base64 -d 2>/dev/null | jq -r ".exp // 0" 2>/dev/null) || EXP=0
    NOW=$(date +%s)
    if [[ -z "$EXP" ]] || [[ "$EXP" -lt $((NOW + 3600)) ]]; then
      NEEDS_REFRESH=true
    fi
  fi

  if [[ "$NEEDS_REFRESH" == "true" ]]; then
    COL_CRED=$(cat "$KEY_FILE")
    RESP=$(curl -s --max-time 3 "https://thecolony.cc/api/v1/auth/token" \
      -X POST \
      -H "Content-Type: application/json" \
      -d "{\"api_key\":\"$COL_CRED\"}" 2>/dev/null) || RESP=""
    TOKEN=$(echo "$RESP" | jq -r ".access_token // empty" 2>/dev/null) || TOKEN=""
    if [[ -n "$TOKEN" ]]; then
      echo -n "$TOKEN" > "$JWT_FILE"
      echo "[token-refresh] Colony JWT refreshed"
    else
      echo "[token-refresh] Colony JWT refresh failed: ${RESP:-(empty response)}"
    fi
  fi
'

# --- imanagent.dev ---
tw_run "imanagent" bash -c '
  TOKEN_FILE="$HOME/.imanagent-token"
  DIR_PATH="'"$DIR"'"

  # Circuit-breaker check
  CIRCUITS_FILE="'"$CIRCUITS_FILE"'"
  if [[ -f "$CIRCUITS_FILE" ]]; then
    failures=$(jq -r ".imanagent.consecutive_failures // 0" "$CIRCUITS_FILE" 2>/dev/null) || failures=0
    [[ "$failures" -ge 3 ]] && echo "[token-refresh] imanagent circuit-broken, skipping" && exit 0
  fi

  if [[ -f "$TOKEN_FILE" ]]; then
    EXPIRES=$(node -e "try{const t=JSON.parse(require(\"fs\").readFileSync(\"$TOKEN_FILE\",\"utf8\"));console.log(t.token_expires_at)}catch{console.log(\"expired\")}" 2>/dev/null) || EXPIRES="expired"
    NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if [[ "$EXPIRES" > "$NOW_ISO" ]]; then
      exit 0  # Token still valid
    fi
  fi

  if [[ -f "$DIR_PATH/imanagent-verify.mjs" ]]; then
    echo "[token-refresh] imanagent token expired or missing, refreshing..."
    (cd "$DIR_PATH" && timeout 3 node imanagent-verify.mjs 2>&1 | tail -3) || echo "[token-refresh] imanagent refresh failed (exit $?)"
  fi
'

# Wait with watchdog
tw_wait
