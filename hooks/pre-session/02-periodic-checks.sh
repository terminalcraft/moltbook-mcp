#!/bin/bash
# Pre-session: consolidated periodic + health checks (wq-745, d070, d074 Group 6).
# Merges 02-periodic-evm-balance.sh + 02-periodic-platform-health.sh + 11-service-liveness.sh
# into a single hook with shared interval-skip logic.
# R#332 (d074 Group 6): absorbed 10-health-check.sh + 15-presence-heartbeat.sh + 20-poll-directories.sh
#
# Interval-gated checks:
#   - EVM balance: every 70 sessions
#   - Platform health: every 20 sessions
#   - Service liveness: every 20 sessions (with cache-wrapper TTL)
# Every-session checks:
#   - API health probe
#   - Presence heartbeat
#   - Service directory poll
#
# All checks run as parallel background jobs to reduce wall-clock time (R#300).
# Uses timeout-wrapper.sh for per-check timeouts and overall watchdog (wq-880).
# wq-991: Tightened timeouts (HOOK=18→10s, CHECK=10→6s, platform-health=15→8s)
# to cap P95 spikes. Platform-health was 12-14s, service-liveness ~10s on every-20 runs.

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HOOKS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="${LOG_DIR:-$STATE_DIR/logs}"
SESSION_NUM="${SESSION_NUM:-0}"

# Skip session 0
[ "$SESSION_NUM" -eq 0 ] && exit 0

# Source timeout-wrapper library
source "$HOOKS_DIR/lib/timeout-wrapper.sh"

# Configure timeouts (wq-991: reduced from 18/10 to cap P95 spikes)
HOOK_TIMEOUT=10
CHECK_TIMEOUT=6
TIMING_FILE="$STATE_DIR/periodic-check-timing.jsonl"

# Export variables needed by subshells
export DIR STATE_DIR LOG_DIR SESSION_NUM TIMING_FILE

###############################################################################
# Check 1: EVM wallet balance (every 70 sessions)
###############################################################################
if [ $((SESSION_NUM % 70)) -eq 0 ]; then
  tw_run "evm-balance" bash -c '
    EVM_PREV_FILE="$STATE_DIR/evm-balance.json"
    PREV_TOTAL=0
    if [ -f "$EVM_PREV_FILE" ]; then
      PREV_TOTAL=$(jq -r ".total_usdc // 0" "$EVM_PREV_FILE" 2>/dev/null || echo "0")
    fi

    EVM_OUTPUT=$(node "$DIR/check-evm-balance.mjs" --json 2>&1) || true
    [ -z "$EVM_OUTPUT" ] && EVM_OUTPUT="{\"total_usdc\":0,\"error\":\"check failed\"}"
    NEW_TOTAL=$(echo "$EVM_OUTPUT" | jq -r ".total_usdc // 0" 2>/dev/null || echo "0")

    ALERT=""
    if [ "$(echo "$PREV_TOTAL" | awk "{print (\$1 == 0)}")" = "1" ] && [ "$(echo "$NEW_TOTAL" | awk "{print (\$1 > 0)}")" = "1" ]; then
      ALERT="DEPOSIT_DETECTED: ${NEW_TOTAL} USDC appeared"
    elif [ "$(echo "$PREV_TOTAL $NEW_TOTAL" | awk "{print (\$1 > 0.01 && \$2 < \$1 * 0.9)}")" = "1" ]; then
      ALERT="BALANCE_DROP: ${PREV_TOTAL} -> ${NEW_TOTAL} USDC"
    fi

    if [ -n "$ALERT" ]; then
      echo "$(date -Iseconds) s=$SESSION_NUM: $ALERT" >> "$STATE_DIR/evm-balance-alert.txt"
    fi

    echo "$(date -Iseconds) periodic-evm-balance: s=$SESSION_NUM prev=${PREV_TOTAL} new=${NEW_TOTAL} alert=${ALERT:-none}" >> "$LOG_DIR/selfmod.log"
  '
fi

###############################################################################
# Check 2: Platform health (every 20 sessions)
###############################################################################
if [ $((SESSION_NUM % 20)) -eq 0 ]; then
  tw_run "platform-health" --timeout 8 bash -c '
    HEALTH_OUTPUT=$(node "$DIR/account-manager.mjs" test --all --fast 2>&1) || true
    FAILED_COUNT=$(echo "$HEALTH_OUTPUT" | grep -c "FAIL\|error\|unreachable" 2>/dev/null || true)
    FAILED_COUNT="${FAILED_COUNT:-0}"
    [[ "$FAILED_COUNT" =~ ^[0-9]+$ ]] || FAILED_COUNT=0
    if [ "$FAILED_COUNT" -gt 0 ]; then
      echo "$(date -Iseconds) s=$SESSION_NUM: $FAILED_COUNT platform(s) unhealthy" >> "$STATE_DIR/platform-health-alert.txt"
      echo "$HEALTH_OUTPUT" | grep -E "FAIL|error|unreachable" >> "$STATE_DIR/platform-health-alert.txt"
      echo "---" >> "$STATE_DIR/platform-health-alert.txt"
    fi

    echo "$(date -Iseconds) periodic-platform-health: s=$SESSION_NUM failed=$FAILED_COUNT" >> "$LOG_DIR/selfmod.log"
  '
fi

###############################################################################
# Check 3: Service liveness (every 20 sessions, with cache)
###############################################################################
if [ $((SESSION_NUM % 20)) -eq 0 ]; then
  tw_run "service-liveness" bash -c '
    source "'"$HOOKS_DIR"'/lib/cache-wrapper.sh"
    echo "[liveness] Running service liveness check (session $SESSION_NUM)..."
    cd "$DIR"
    cache_run "service-liveness" 120 node service-liveness.mjs --update
    echo "[liveness] Done."
  '
fi

###############################################################################
# Check 4: API health probe
# Full probe (3 external HTTPS endpoints) every 10 sessions — the search
# endpoint alone averages 4-5s, causing 6s+ hook times on every session.
# Every-session check is a fast localhost-only probe (~100ms).
###############################################################################
if [ $((SESSION_NUM % 10)) -eq 0 ]; then
  tw_run "api-health" --timeout 8 bash -c '
    node "$DIR/health-check.cjs" >> "$LOG_DIR/health.log" 2>&1 || true
  '
else
  tw_run "api-health" bash -c '
    curl -s -o /dev/null -w "" --max-time 2 http://127.0.0.1:3847/health 2>/dev/null || true
  '
fi

###############################################################################
# Check 5: Presence heartbeat (every session — absorbed from 15-presence-heartbeat.sh)
###############################################################################
tw_run "presence" bash -c '
  TOKEN=$(cat "$HOME/.config/moltbook/api-token" 2>/dev/null || echo "changeme")
  curl -s -X POST http://127.0.0.1:3847/presence \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"handle\":\"moltbook\",\"capabilities\":[\"knowledge-exchange\",\"webhooks\",\"kv\",\"cron\",\"polls\",\"paste\",\"registry\",\"leaderboard\",\"presence\",\"reputation\"]}" \
    > /dev/null 2>&1 || true
'

###############################################################################
# Check 6: Service directory poll (every session — absorbed from 20-poll-directories.sh)
###############################################################################
tw_run "directory-poll" bash -c '
  node "$DIR/poll-directories.cjs" >> "$LOG_DIR/discovery.log" 2>&1 || true
'

###############################################################################
# Wait with overall timeout watchdog
###############################################################################
tw_wait
