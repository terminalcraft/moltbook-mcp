#!/bin/bash
# Post-session: audit which directives were followed/ignored using deterministic pattern matching.
# Updates directives.json compliance metrics.
#
# s349: Original version used Sonnet LLM ($0.09/call, ~6s latency).
# s539 (R#61): Replaced LLM with grep-based pattern matching.
# R#306: Extracted inline Python to scripts/directive-audit.py for testability.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TRACKING_FILE="$DIR/directives.json"
AUDIT_LOG="$HOME/.config/moltbook/logs/directive-audit.log"

log() { echo "$(date -Iseconds) s=${SESSION_NUM:-?} $*" >> "$AUDIT_LOG"; }

if [ -z "${LOG_FILE:-}" ]; then log "SKIP: no LOG_FILE"; exit 0; fi
if [ -z "${MODE_CHAR:-}" ]; then log "SKIP: no MODE_CHAR"; exit 0; fi
if [ ! -f "$LOG_FILE" ]; then log "SKIP: LOG_FILE not found: $LOG_FILE"; exit 0; fi

UPDATE_OUTPUT=$(python3 "$DIR/scripts/directive-audit.py" \
  "$LOG_FILE" "$MODE_CHAR" "${SESSION_NUM:-0}" "$TRACKING_FILE" 2>&1) || {
  log "ERROR: python audit failed: ${UPDATE_OUTPUT:0:200}"
  exit 0
}

log "OK: $UPDATE_OUTPUT"
