#!/bin/bash
# Pre-session: consolidated periodic checks (wq-745, d070).
# Merges 02-periodic-evm-balance.sh + 02-periodic-platform-health.sh + 11-service-liveness.sh
# into a single hook with shared interval-skip logic.
#
# Each check has its own interval:
#   - EVM balance: every 70 sessions
#   - Platform health: every 20 sessions
#   - Service liveness: every 20 sessions (with cache-wrapper TTL)
#
# All checks run as parallel background jobs to reduce wall-clock time (R#300).
# Each check has a 10s hard timeout to prevent p95 spikes (wq-842).
# Overall hook capped at 12s via watchdog.

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HOOKS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="${LOG_DIR:-$STATE_DIR/logs}"
SESSION_NUM="${SESSION_NUM:-0}"
TIMING_FILE="$STATE_DIR/periodic-check-timing.jsonl"

# Per-check timeout (seconds). Each individual check is killed after this.
CHECK_TIMEOUT=10
# Overall hook timeout. Watchdog kills all remaining children after this.
HOOK_TIMEOUT=12

# Skip session 0
[ "$SESSION_NUM" -eq 0 ] && exit 0

PIDS=()
CHECK_NAMES=()
HOOK_START=$(date +%s%N)

# Helper: record per-check timing to JSONL telemetry file
log_check_timing() {
  local name="$1" start_ns="$2" exit_code="$3"
  local end_ns
  end_ns=$(date +%s%N)
  local elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))
  local timed_out="false"
  [ "$exit_code" -eq 124 ] && timed_out="true"
  echo "{\"ts\":\"$(date -Iseconds)\",\"session\":$SESSION_NUM,\"check\":\"$name\",\"ms\":$elapsed_ms,\"exit\":$exit_code,\"timeout\":$timed_out}" >> "$TIMING_FILE"
}

###############################################################################
# Check 1: EVM wallet balance (every 70 sessions)
###############################################################################
if [ $((SESSION_NUM % 70)) -eq 0 ]; then
  (
    START_NS=$(date +%s%N)
    EVM_PREV_FILE="$STATE_DIR/evm-balance.json"
    PREV_TOTAL=0
    if [ -f "$EVM_PREV_FILE" ]; then
      PREV_TOTAL=$(jq -r '.total_usdc // 0' "$EVM_PREV_FILE" 2>/dev/null || echo "0")
    fi

    EVM_OUTPUT=$(timeout $CHECK_TIMEOUT node "$DIR/check-evm-balance.mjs" --json 2>&1)
    EC=$?
    [ -z "$EVM_OUTPUT" ] && EVM_OUTPUT='{"total_usdc":0,"error":"check failed or timeout"}'
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
    log_check_timing "evm-balance" "$START_NS" "$EC"
  ) &
  PIDS+=($!)
  CHECK_NAMES+=("evm-balance")
fi

###############################################################################
# Check 2: Platform health (every 20 sessions)
###############################################################################
if [ $((SESSION_NUM % 20)) -eq 0 ]; then
  (
    START_NS=$(date +%s%N)
    HEALTH_OUTPUT=$(timeout $CHECK_TIMEOUT node "$DIR/account-manager.mjs" test --all 2>&1)
    EC=$?
    FAILED_COUNT=$(echo "$HEALTH_OUTPUT" | grep -c "FAIL\|error\|unreachable" 2>/dev/null || true)
    FAILED_COUNT="${FAILED_COUNT:-0}"
    # Ensure numeric (grep -c can produce unexpected output if input is truncated)
    [[ "$FAILED_COUNT" =~ ^[0-9]+$ ]] || FAILED_COUNT=0
    if [ "$FAILED_COUNT" -gt 0 ]; then
      echo "$(date -Iseconds) s=$SESSION_NUM: $FAILED_COUNT platform(s) unhealthy" >> "$STATE_DIR/platform-health-alert.txt"
      echo "$HEALTH_OUTPUT" | grep -E "FAIL|error|unreachable" >> "$STATE_DIR/platform-health-alert.txt"
      echo "---" >> "$STATE_DIR/platform-health-alert.txt"
    fi

    echo "$(date -Iseconds) periodic-platform-health: s=$SESSION_NUM failed=$FAILED_COUNT" >> "$LOG_DIR/selfmod.log"
    log_check_timing "platform-health" "$START_NS" "$EC"
  ) &
  PIDS+=($!)
  CHECK_NAMES+=("platform-health")
fi

###############################################################################
# Check 3: Service liveness (every 20 sessions, with cache)
###############################################################################
if [ $((SESSION_NUM % 20)) -eq 0 ]; then
  (
    START_NS=$(date +%s%N)
    source "$HOOKS_DIR/lib/cache-wrapper.sh"
    echo "[liveness] Running service liveness check (session $SESSION_NUM)..."
    cd "$DIR"
    cache_run "service-liveness" 120 timeout $CHECK_TIMEOUT node service-liveness.mjs --update
    EC=$?
    echo "[liveness] Done."
    log_check_timing "service-liveness" "$START_NS" "$EC"
  ) &
  PIDS+=($!)
  CHECK_NAMES+=("service-liveness")
fi

###############################################################################
# Wait with overall timeout watchdog (wq-842)
###############################################################################
if [ ${#PIDS[@]} -gt 0 ]; then
  # Write PIDs to a temp file so watchdog subshell can read them
  PID_FILE=$(mktemp)
  printf '%s\n' "${PIDS[@]}" > "$PID_FILE"

  # Watchdog: kill all children after HOOK_TIMEOUT seconds
  (
    sleep $HOOK_TIMEOUT
    while IFS= read -r pid; do
      kill "$pid" 2>/dev/null
    done < "$PID_FILE"
    rm -f "$PID_FILE"
    echo "$(date -Iseconds) periodic-checks-watchdog: s=$SESSION_NUM killed stragglers after ${HOOK_TIMEOUT}s" >> "$LOG_DIR/selfmod.log"
  ) &
  WATCHDOG_PID=$!

  # Wait for all checks to finish (or be killed by watchdog)
  wait "${PIDS[@]}" 2>/dev/null

  # Cancel watchdog if checks finished before timeout
  kill "$WATCHDOG_PID" 2>/dev/null
  wait "$WATCHDOG_PID" 2>/dev/null
  rm -f "$PID_FILE" 2>/dev/null

  # Log overall hook timing
  HOOK_END=$(date +%s%N)
  HOOK_MS=$(( (HOOK_END - HOOK_START) / 1000000 ))
  echo "{\"ts\":\"$(date -Iseconds)\",\"session\":$SESSION_NUM,\"check\":\"_total\",\"ms\":$HOOK_MS,\"checks\":[$(printf '"%s",' "${CHECK_NAMES[@]}" | sed 's/,$//')]}" >> "$TIMING_FILE"
fi
