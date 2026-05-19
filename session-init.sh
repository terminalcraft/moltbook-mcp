#!/bin/bash
# session-init.sh — Session initialization pipeline.
# Extracted from heartbeat.sh (R#319) to reduce complexity.
# Provides: safe_stage(), arg parsing, lock acquisition, orphan cleanup,
# outage-aware skip, log rotation, and directive enrichment + pre-session hooks.
# R#377: Replaced eval-based safe_stage with function-reference pattern.
#
# Expected variables from caller:
#   DIR, STATE_DIR, LOG_DIR (set before sourcing)
# Sets:
#   DRY_RUN, OVERRIDE_MODE, SAFE_MODE, EMERGENCY_MODE, INIT_DEGRADED, INIT_FAILURES

# --- Stage isolation helper ---
# Wraps each init stage so failures log + use defaults instead of crashing.
# Usage: safe_stage "stage_name" default_action <<< "commands"
# Returns 0 always. Sets INIT_DEGRADED=1 if any stage failed.
INIT_DEGRADED=""
INIT_FAILURES=""
safe_stage() {
  local stage_name="$1"
  shift
  if "$@" 2>>"$LOG_DIR/init-errors.log"; then
    return 0
  else
    local exit_code=$?
    INIT_DEGRADED=1
    INIT_FAILURES="${INIT_FAILURES:+$INIT_FAILURES, }$stage_name"
    echo "$(date -Iseconds) [init] stage '$stage_name' failed (exit $exit_code), using defaults" >> "$LOG_DIR/init-errors.log"
    return 0
  fi
}

# Accept optional flags: mode override (E, B, R), --dry-run, --safe-mode, --emergency
DRY_RUN=""
OVERRIDE_MODE=""
SAFE_MODE=""
EMERGENCY_MODE=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --safe-mode) SAFE_MODE=1 ;;
    --emergency) EMERGENCY_MODE=1 ;;
    E|B|R) OVERRIDE_MODE="$arg" ;;
  esac
done

# Acquire lock BEFORE killing orphans to avoid killing a running session's MCP server.
# Fix for wq-766: pkill ran before lock check, so even skipped heartbeats killed the
# active session's MCP node process, causing early stalls.
LOCKFILE="$STATE_DIR/heartbeat.lock"
if [ -z "$DRY_RUN" ]; then
  exec 200>"$LOCKFILE"
  if ! flock -n 200; then
    echo "$(date -Iseconds) heartbeat already running, skipping" >> "$LOG_DIR/skipped.log"
    exit 0
  fi
fi

# Kill orphan MCP node processes from previous crashed sessions
# Safe now: lock is held, so no active session is running
if [ -z "$DRY_RUN" ]; then
  pkill -f "node $DIR/index.js" 2>/dev/null || true
  sleep 1
fi

# --- Claude API DNS pre-flight (R#369) ---
# s2026-s2044: 19 sessions wasted ~4min each on EAI_AGAIN (DNS failure for api.anthropic.com).
# The existing outage check only tests Moltbook API, not Claude API reachability.
# This check exits immediately if DNS can't resolve, saving the full retry cycle.
run_api_dns_check() {
  if [ -z "$SAFE_MODE" ] && [ -z "$EMERGENCY_MODE" ] && [ -z "$DRY_RUN" ]; then
    local dns_fail_file="$STATE_DIR/api_dns_failures"
    if ! getent hosts api.anthropic.com >/dev/null 2>&1; then
      local fail_count=0
      [ -f "$dns_fail_file" ] && fail_count=$(cat "$dns_fail_file")
      fail_count=$((fail_count + 1))
      echo "$fail_count" > "$dns_fail_file"
      echo "$(date -Iseconds) dns-preflight: api.anthropic.com unresolvable (streak: $fail_count), skipping session" >> "$LOG_DIR/skipped.log"
      exit 0
    else
      # DNS works — reset failure counter
      rm -f "$dns_fail_file"
    fi
  fi
}

# --- Generic error-streak circuit breaker (wq-1005, A#250) ---
# s2026-s2044: 19 consecutive failures burned ~75 min with zero output.
# DNS pre-flight handles that specific case; this handles ANY failure mode
# (API auth, rate limiting, MCP crash, etc.) by reading outcomes.log.
# After N consecutive exit=1 entries, skip with exponential backoff.
# N=3 threshold, backoff: skip next 2^(streak-3) sessions (capped at 8).
run_error_streak_check() {
  if [ -z "$SAFE_MODE" ] && [ -z "$EMERGENCY_MODE" ] && [ -z "$DRY_RUN" ]; then
    local outcomes_file="$LOG_DIR/outcomes.log"
    local streak_skip_file="$STATE_DIR/error_streak_skip"
    local STREAK_THRESHOLD=3

    # If skip file exists, we're in backoff — decrement and skip
    if [ -f "$streak_skip_file" ]; then
      local remaining
      remaining=$(cat "$streak_skip_file")
      if [ "${remaining:-0}" -gt 0 ]; then
        echo "$((remaining - 1))" > "$streak_skip_file"
        echo "$(date -Iseconds) circuit-breaker: skipping session (backoff remaining: $remaining)" >> "$LOG_DIR/skipped.log"
        exit 0
      else
        # Backoff expired — remove file and proceed
        rm -f "$streak_skip_file"
      fi
    fi

    # Count consecutive failures from end of outcomes.log
    if [ -f "$outcomes_file" ]; then
      local streak=0
      while IFS= read -r line; do
        if echo "$line" | grep -q "exit=1"; then
          streak=$((streak + 1))
        else
          break
        fi
      done < <(tail -20 "$outcomes_file" | tac)

      if [ "$streak" -ge "$STREAK_THRESHOLD" ]; then
        # Calculate backoff: 2^(streak - threshold), capped at 8
        local backoff_exp=$((streak - STREAK_THRESHOLD))
        local skip_count=1
        local i=0
        while [ $i -lt $backoff_exp ] && [ $skip_count -lt 8 ]; do
          skip_count=$((skip_count * 2))
          i=$((i + 1))
        done
        [ $skip_count -gt 8 ] && skip_count=8

        echo "$((skip_count - 1))" > "$streak_skip_file"
        echo "$(date -Iseconds) circuit-breaker: $streak consecutive failures detected (threshold=$STREAK_THRESHOLD), entering backoff (skip next $((skip_count - 1)) sessions)" >> "$LOG_DIR/skipped.log"
        # Don't skip THIS session — let it try once to see if the issue resolved.
        # The backoff kicks in on the NEXT invocation if this one also fails.
        # But if streak is very high (>= threshold + 3 = 6), skip immediately.
        if [ "$streak" -ge $((STREAK_THRESHOLD + 3)) ]; then
          echo "$(date -Iseconds) circuit-breaker: streak=$streak >= $(( STREAK_THRESHOLD + 3 )), skipping immediately" >> "$LOG_DIR/skipped.log"
          exit 0
        fi
      fi
    fi
  fi
}

# --- Outage-aware session skip ---
# If API has been down 5+ consecutive checks, skip every other heartbeat.
# Skip this check in safe/emergency mode — we want to try regardless.
_outage_check() {
  local SKIP_FILE="$STATE_DIR/outage_skip_toggle"
  local API_STATUS
  API_STATUS=$(node "$DIR/health-check.cjs" --status 2>&1 || true)
  if echo "$API_STATUS" | grep -q "^DOWN" ; then
    local DOWN_COUNT
    DOWN_COUNT=$(echo "$API_STATUS" | grep -oP "down \K[0-9]+")
    if [ "${DOWN_COUNT:-0}" -ge 5 ]; then
      if [ -f "$SKIP_FILE" ]; then
        rm -f "$SKIP_FILE"
        echo "$(date -Iseconds) outage skip: API down $DOWN_COUNT checks, skipping this session" >> "$LOG_DIR/skipped.log"
        exit 0
      else
        touch "$SKIP_FILE"
      fi
    else
      rm -f "$SKIP_FILE"
    fi
  else
    rm -f "$SKIP_FILE"
  fi
}

run_outage_check() {
  if [ -z "$SAFE_MODE" ] && [ -z "$EMERGENCY_MODE" ]; then
    safe_stage "outage-check" _outage_check
  fi
}

# --- Log rotation (non-critical, never abort on failure) ---
_log_rotation() {
  local SESSION_LOGS
  SESSION_LOGS=( $(ls -t "$LOG_DIR"/20*.log 2>/dev/null) )
  if [ ${#SESSION_LOGS[@]} -gt 20 ]; then
    for old_log in "${SESSION_LOGS[@]:20}"; do
      rm -f "$old_log"
    done
    echo "$(date -Iseconds) log-rotate: removed $((${#SESSION_LOGS[@]} - 20)) old session logs" >> "$LOG_DIR/selfmod.log"
  fi
  for util_log in "$LOG_DIR/cron.log" "$LOG_DIR/hooks.log" "$LOG_DIR/health.log"; do
    if [ -f "$util_log" ] && [ "$(stat -c%s "$util_log" 2>/dev/null || echo 0)" -gt 1048576 ]; then
      tail -100 "$util_log" > "${util_log}.tmp" && mv "${util_log}.tmp" "$util_log"
      echo "$(date -Iseconds) log-rotate: truncated $(basename "$util_log")" >> "$LOG_DIR/selfmod.log"
    fi
  done
}

run_log_rotation() {
  safe_stage "log-rotation" _log_rotation
}

# --- Directive enrichment + pre-session hooks (skipped in safe/emergency mode) ---
_directive_enrichment() {
  node "$DIR/scripts/directive-enrichment.mjs" "$DIR/directives.json" "$DIR/work-queue.json" "$STATE_DIR/directive-enrichment.json" 2>/dev/null
}

_pre_session_hooks() {
  local mode_char="$1" counter="$2" r_focus="$3" b_focus="$4"
  MODE_CHAR="$mode_char" SESSION_NUM="$counter" R_FOCUS="$r_focus" B_FOCUS="$b_focus" \
    LOG_DIR="$LOG_DIR" \
    DIRECTIVE_ENRICHMENT="$STATE_DIR/directive-enrichment.json" \
    "$DIR/run-hooks.sh" "$DIR/hooks/pre-session" 30 \
      --track "$LOG_DIR/pre-hook-results.json" "$counter" \
      --budget 90 --parallel 4
}

run_presession_pipeline() {
  local mode_char="$1" counter="$2" r_focus="$3" b_focus="$4"
  if [ -z "$DRY_RUN" ] && [ -z "$SAFE_MODE" ] && [ -z "$EMERGENCY_MODE" ]; then
    safe_stage "directive-enrichment" _directive_enrichment
    safe_stage "pre-session-hooks" _pre_session_hooks "$mode_char" "$counter" "$r_focus" "$b_focus"
  fi
}

# Run the init sequence
run_api_dns_check
run_error_streak_check
run_outage_check
run_log_rotation
