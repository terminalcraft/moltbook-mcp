#!/bin/bash
# Wrapper around heartbeat.sh that auto-heals from startup crashes.
# Cron calls this instead of heartbeat.sh directly.
#
# Flow — 3-tier progressive degradation:
# 1. FULL: Run heartbeat.sh normally (all init stages, hooks, context)
# 2. SAFE: If full fails before reaching Claude, retry with --safe-mode
#    (skips hooks, mode transforms, context enrichment — just rotation + prompt + Claude)
# 3. EMERGENCY: If safe also fails, retry with --emergency
#    (hardcoded B session, base prompt only, no external scripts — guaranteed to reach Claude)
#
# After any successful session, update known-good backup.
# DO NOT REMOVE OR MODIFY THIS FILE without human approval.

set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="$STATE_DIR/logs"
CRASH_FILE="$STATE_DIR/last-crash.txt"
KNOWN_GOOD="$DIR/heartbeat.sh.known-good"
HEARTBEAT="$DIR/heartbeat.sh"
SELFMOD_LOG="$LOG_DIR/selfmod.log"

mkdir -p "$LOG_DIR"

log() { echo "$(date -Iseconds) [run-heartbeat] $*" >> "$SELFMOD_LOG"; }

# Detect if a session was created by counting log files
count_logs() { ls "$LOG_DIR"/20*.log 2>/dev/null | wc -l; }

# Try to run heartbeat at a given tier. Returns 0 if session launched (even if session
# itself later failed/timed out — that's fine, it means init succeeded).
try_tier() {
  local tier_name="$1"
  shift
  local extra_args=("$@")

  local logs_before
  logs_before=$(count_logs)

  log "TIER $tier_name: attempting heartbeat ${extra_args[*]:+(${extra_args[*]})}"

  # Run heartbeat, capture exit code without aborting wrapper
  set +e
  bash "$HEARTBEAT" "${extra_args[@]}" "${PASSTHROUGH_ARGS[@]}"
  local exit_code=$?
  set -e

  local logs_after
  logs_after=$(count_logs)

  if [ "$exit_code" -eq 0 ] || [ "$logs_after" -gt "$logs_before" ]; then
    # Session launched (log created) or exited cleanly — init succeeded
    log "TIER $tier_name: success (exit=$exit_code, logs=$logs_before→$logs_after)"
    return 0
  else
    # Init crashed before creating a session log
    local error_snippet
    error_snippet=$(bash "$HEARTBEAT" "${extra_args[@]}" "$PASSTHROUGH_ARGS" 2>&1 | tail -5 || true)
    log "TIER $tier_name: FAILED (exit=$exit_code) — $error_snippet"
    return 1
  fi
}

# Collect passthrough args (mode overrides, --dry-run) but strip our internal flags
PASSTHROUGH_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --safe-mode|--emergency) ;; # don't pass these through from cron
    *) PASSTHROUGH_ARGS+=("$arg") ;;
  esac
done

# === TIER 1: FULL ===
if try_tier "FULL" ; then
  # Success — update known-good backup
  cp "$HEARTBEAT" "$KNOWN_GOOD"
  exit 0
fi

# === TIER 2: SAFE MODE (skip hooks, transforms, context enrichment) ===
# First, try restoring known-good heartbeat.sh in case the script itself is broken
if [ -f "$KNOWN_GOOD" ]; then
  cp "$KNOWN_GOOD" "$HEARTBEAT"
  chmod +x "$HEARTBEAT"
  log "Restored heartbeat.sh from known-good for safe-mode attempt"
fi

if try_tier "SAFE" --safe-mode; then
  exit 0
fi

# === TIER 3: EMERGENCY (hardcoded B, base prompt only, no external scripts) ===
if try_tier "EMERGENCY" --emergency; then
  # Write crash report for human review
  cat > "$CRASH_FILE" << CRASHEOF
timestamp: $(date -Iseconds)
tiers_attempted: FULL, SAFE, EMERGENCY
result: Emergency session launched (full and safe init both failed)
action_needed: Check $LOG_DIR/init-errors.log for stage failures
CRASHEOF
  exit 0
fi

# === ALL TIERS FAILED — something is fundamentally broken ===
log "ALL TIERS FAILED. Molty is down. Human intervention required."
cat > "$CRASH_FILE" << CRASHEOF
timestamp: $(date -Iseconds)
tiers_attempted: FULL, SAFE, EMERGENCY
result: ALL FAILED — molty cannot start at any degradation level
likely_cause: claude CLI broken, filesystem issue, or base-prompt.md missing
action_needed: SSH in and debug manually
CRASHEOF
exit 1
