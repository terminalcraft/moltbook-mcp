#!/bin/bash
# Log queue compliance for B sessions: was the assigned wq item completed?
# Writes to ~/.config/moltbook/logs/queue-compliance.log
# Format: timestamp session_num assigned_id assigned_title status
# status: completed | incomplete | no_assignment

set -euo pipefail

# Only track B sessions
[ "${MODE_CHAR:-}" = "B" ] || exit 0

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="$STATE_DIR/logs"
COMPLIANCE_LOG="$LOG_DIR/queue-compliance.log"

# Figure out what was assigned by checking the session log for the injected task line
ASSIGNED_ID=""
ASSIGNED_TITLE=""
if [ -n "${LOG_FILE:-}" ] && [ -f "$LOG_FILE" ]; then
  # The prompt contains "## YOUR ASSIGNED TASK" with "wq-NNN: title"
  TASK_LINE=$(grep -oP 'wq-\d+:.*' "$LOG_FILE" | head -1 || true)
  if [ -n "$TASK_LINE" ]; then
    ASSIGNED_ID=$(echo "$TASK_LINE" | grep -oP 'wq-\d+' | head -1)
    ASSIGNED_TITLE=$(echo "$TASK_LINE" | sed 's/^wq-[0-9]*: //')
  fi
fi

if [ -z "$ASSIGNED_ID" ]; then
  echo "$(date -Iseconds) s=${SESSION_NUM:-?} assigned=none status=no_assignment" >> "$COMPLIANCE_LOG"
  exit 0
fi

# Check if the assigned item is now in the completed array
STATUS="incomplete"
if [ -f "$DIR/work-queue.json" ]; then
  IS_COMPLETED=$(node -e "
    const q=JSON.parse(require('fs').readFileSync('$DIR/work-queue.json','utf8'));
    const found=q.completed&&q.completed.find(i=>i.id==='$ASSIGNED_ID'&&i.status==='completed');
    console.log(found?'yes':'no');
  " 2>/dev/null || echo "no")
  [ "$IS_COMPLETED" = "yes" ] && STATUS="completed"
fi

echo "$(date -Iseconds) s=${SESSION_NUM:-?} assigned=$ASSIGNED_ID title=\"${ASSIGNED_TITLE:0:100}\" status=$STATUS" >> "$COMPLIANCE_LOG"
