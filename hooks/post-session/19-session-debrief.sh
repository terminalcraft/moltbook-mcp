#!/bin/bash
# Post-session hook: extract decisions, blockers, and outcomes from session log.
# Delegates to scripts/session-debrief.mjs for robust JSONL parsing.
#
# Migrated from python3 to node (wq-728, B#485)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$HOME/.config/moltbook/logs"

if [ -z "${LOG_FILE:-}" ] || [ ! -f "$LOG_FILE" ]; then
  exit 0
fi

FOCUS=""
[ -n "${B_FOCUS:-}" ] && FOCUS="$B_FOCUS"
[ -n "${R_FOCUS:-}" ] && FOCUS="$R_FOCUS"

node "$DIR/scripts/session-debrief.mjs" "$LOG_FILE" "${SESSION_NUM:-0}" "${MODE_CHAR:-?}" "$FOCUS" 2>> "$LOG_DIR/debrief-errors.log" || true
