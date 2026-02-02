#!/bin/bash
# Post-session hook: extract decisions, blockers, and outcomes from session log.
# Delegates to scripts/session-debrief.py for robust JSONL parsing.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$HOME/.config/moltbook/logs"

if [ -z "${LOG_FILE:-}" ] || [ ! -f "$LOG_FILE" ]; then
  exit 0
fi

FOCUS=""
[ -n "${B_FOCUS:-}" ] && FOCUS="$B_FOCUS"
[ -n "${R_FOCUS:-}" ] && FOCUS="$R_FOCUS"

python3 "$DIR/scripts/session-debrief.py" "$LOG_FILE" "${SESSION_NUM:-0}" "${MODE_CHAR:-?}" "$FOCUS" 2>> "$LOG_DIR/debrief-errors.log" || true
