#!/bin/bash
# Wrapper around heartbeat.sh that auto-heals from startup crashes.
# Cron calls this instead of heartbeat.sh directly.
#
# Flow:
# 1. Run heartbeat.sh
# 2. If it crashes before reaching Claude (exit code != 0, no session log created),
#    restore heartbeat.sh from known-good copy, log the crash, retry once.
# 3. On successful session completion, update the known-good copy.
#
# Added by human operator to prevent self-inflicted downtime from bad heartbeat edits.
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

# Count session logs before running (to detect if a session actually started)
LOGS_BEFORE=$(ls "$LOG_DIR"/2026*.log 2>/dev/null | wc -l)

# Run heartbeat
bash "$HEARTBEAT" "$@"
EXIT_CODE=$?

LOGS_AFTER=$(ls "$LOG_DIR"/2026*.log 2>/dev/null | wc -l)

if [ $EXIT_CODE -ne 0 ] && [ "$LOGS_AFTER" -eq "$LOGS_BEFORE" ]; then
    # Heartbeat crashed before creating a session log — startup failure.
    ERROR_MSG=$(bash "$HEARTBEAT" "$@" 2>&1 | tail -5)

    log "CRASH DETECTED: heartbeat.sh exited $EXIT_CODE before creating session log"
    log "Error: $ERROR_MSG"

    # Write crash file for the next session to see
    cat > "$CRASH_FILE" << CRASHEOF
timestamp: $(date -Iseconds)
exit_code: $EXIT_CODE
error: $ERROR_MSG
action: Restored heartbeat.sh from known-good backup. Your last edit to heartbeat.sh likely caused this.
CRASHEOF

    # Restore from known-good if available
    if [ -f "$KNOWN_GOOD" ]; then
        cp "$KNOWN_GOOD" "$HEARTBEAT"
        chmod +x "$HEARTBEAT"
        log "Restored heartbeat.sh from known-good backup. Retrying."

        # Retry once with the restored version
        bash "$HEARTBEAT" "$@"
        RETRY_EXIT=$?
        if [ $RETRY_EXIT -ne 0 ]; then
            log "Retry also failed (exit $RETRY_EXIT). Giving up until next cron tick."
        else
            log "Retry succeeded with known-good heartbeat.sh"
        fi
    else
        log "No known-good backup available. Cannot auto-heal."
    fi
else
    # Session ran (whether it succeeded or timed out doesn't matter — heartbeat.sh is functional).
    # Update known-good copy.
    cp "$HEARTBEAT" "$KNOWN_GOOD"
fi
