#!/bin/bash
# Pre-session: consolidated periodic checks (wq-745, d070).
# Merges 02-periodic-evm-balance.sh + 02-periodic-platform-health.sh + 11-service-liveness.sh
# into a single hook with shared interval-skip logic.
#
# Each check has its own interval:
#   - EVM balance: every 70 sessions
#   - Platform health: every 20 sessions
#   - Service liveness: every 20 sessions (with cache-wrapper TTL)

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="${LOG_DIR:-$STATE_DIR/logs}"
SESSION_NUM="${SESSION_NUM:-0}"

# Skip session 0
[ "$SESSION_NUM" -eq 0 ] && exit 0

###############################################################################
# Check 1: EVM wallet balance (every 70 sessions)
###############################################################################
if [ $((SESSION_NUM % 70)) -eq 0 ]; then
  EVM_PREV_FILE="$STATE_DIR/evm-balance.json"
  PREV_TOTAL=0
  if [ -f "$EVM_PREV_FILE" ]; then
    PREV_TOTAL=$(jq -r '.total_usdc // 0' "$EVM_PREV_FILE" 2>/dev/null || echo "0")
  fi

  EVM_OUTPUT=$(node "$DIR/check-evm-balance.mjs" --json 2>&1 || echo '{"total_usdc":0,"error":"check failed"}')
  NEW_TOTAL=$(echo "$EVM_OUTPUT" | jq -r '.total_usdc // 0' 2>/dev/null || echo "0")

  ALERT=""
  if [ "$(echo "$PREV_TOTAL" | awk '{print ($1 == 0)}')" = "1" ] && [ "$(echo "$NEW_TOTAL" | awk '{print ($1 > 0)}')" = "1" ]; then
    ALERT="DEPOSIT_DETECTED: ${NEW_TOTAL} USDC appeared"
  elif [ "$(echo "$PREV_TOTAL $NEW_TOTAL" | awk '{print ($1 > 0.01 && $2 < $1 * 0.9)}')" = "1" ]; then
    ALERT="BALANCE_DROP: ${PREV_TOTAL} -> ${NEW_TOTAL} USDC"
  fi

  if [ -n "$ALERT" ]; then
    echo "$(date -Iseconds) s=$SESSION_NUM: $ALERT" >> "$STATE_DIR/evm-balance-alert.txt"
  fi

  echo "$(date -Iseconds) periodic-evm-balance: s=$SESSION_NUM prev=${PREV_TOTAL} new=${NEW_TOTAL} alert=${ALERT:-none}" >> "$LOG_DIR/selfmod.log"
fi

###############################################################################
# Check 2: Platform health (every 20 sessions)
###############################################################################
if [ $((SESSION_NUM % 20)) -eq 0 ]; then
  HEALTH_OUTPUT=$(node "$DIR/account-manager.mjs" test --all 2>&1 || true)
  FAILED_COUNT=$(echo "$HEALTH_OUTPUT" | grep -c "FAIL\|error\|unreachable" || echo "0")
  if [ "$FAILED_COUNT" -gt 0 ]; then
    echo "$(date -Iseconds) s=$SESSION_NUM: $FAILED_COUNT platform(s) unhealthy" >> "$STATE_DIR/platform-health-alert.txt"
    echo "$HEALTH_OUTPUT" | grep -E "FAIL|error|unreachable" >> "$STATE_DIR/platform-health-alert.txt"
    echo "---" >> "$STATE_DIR/platform-health-alert.txt"
  fi

  echo "$(date -Iseconds) periodic-platform-health: s=$SESSION_NUM failed=$FAILED_COUNT" >> "$LOG_DIR/selfmod.log"
fi

###############################################################################
# Check 3: Service liveness (every 20 sessions, with cache)
###############################################################################
if [ $((SESSION_NUM % 20)) -eq 0 ]; then
  source "$(dirname "$0")/../lib/cache-wrapper.sh"
  echo "[liveness] Running service liveness check (session $SESSION_NUM)..."
  cd "$DIR"
  cache_run "service-liveness" 120 node service-liveness.mjs --update
  echo "[liveness] Done."
fi
