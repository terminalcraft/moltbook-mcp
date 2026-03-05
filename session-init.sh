#!/bin/bash
# session-init.sh — Session initialization pipeline.
# Extracted from heartbeat.sh (R#319) to reduce complexity.
# Provides: safe_stage(), arg parsing, lock acquisition, orphan cleanup,
# outage-aware skip, log rotation, and directive enrichment + pre-session hooks.
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
  if eval "$@" 2>>"$LOG_DIR/init-errors.log"; then
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

# --- Outage-aware session skip ---
# If API has been down 5+ consecutive checks, skip every other heartbeat.
# Skip this check in safe/emergency mode — we want to try regardless.
run_outage_check() {
  if [ -z "$SAFE_MODE" ] && [ -z "$EMERGENCY_MODE" ]; then
    safe_stage "outage-check" '
      SKIP_FILE="$STATE_DIR/outage_skip_toggle"
      API_STATUS=$(node "$DIR/health-check.cjs" --status 2>&1 || true)
      if echo "$API_STATUS" | grep -q "^DOWN" ; then
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
    '
  fi
}

# --- Log rotation (non-critical, never abort on failure) ---
run_log_rotation() {
  safe_stage "log-rotation" '
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
  '
}

# --- Directive enrichment + pre-session hooks (skipped in safe/emergency mode) ---
run_presession_pipeline() {
  local mode_char="$1"
  local counter="$2"
  local r_focus="$3"
  local b_focus="$4"
  if [ -z "$DRY_RUN" ] && [ -z "$SAFE_MODE" ] && [ -z "$EMERGENCY_MODE" ]; then
    safe_stage "directive-enrichment" \
      'node "$DIR/scripts/directive-enrichment.mjs" "$DIR/directives.json" "$DIR/work-queue.json" "$STATE_DIR/directive-enrichment.json" 2>/dev/null'

    safe_stage "pre-session-hooks" '
      MODE_CHAR="'"$mode_char"'" SESSION_NUM="'"$counter"'" R_FOCUS="'"$r_focus"'" B_FOCUS="'"$b_focus"'" \
        LOG_DIR="$LOG_DIR" \
        DIRECTIVE_ENRICHMENT="$STATE_DIR/directive-enrichment.json" \
        "$DIR/run-hooks.sh" "$DIR/hooks/pre-session" 30 \
          --track "$LOG_DIR/pre-hook-results.json" "'"$counter"'" \
          --budget 90 --parallel 4
    '
  fi
}

# Run the init sequence
run_outage_check
run_log_rotation
