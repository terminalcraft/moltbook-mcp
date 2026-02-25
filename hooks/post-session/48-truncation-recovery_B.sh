#!/bin/bash
# Post-session hook: detect truncated B sessions and re-queue their assigned item.
# Truncation criteria: B session, <3 min duration, 0 commits, assigned wq item still pending/in-progress.
# wq-636

set -euo pipefail

# Only B sessions
[ "${MODE_CHAR:-}" = "B" ] || exit 0

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="$STATE_DIR/logs"
RECOVERY_LOG="$LOG_DIR/truncation-recovery.log"

mkdir -p "$LOG_DIR"

# Compute duration from session log timestamps
DURATION=0
if [ -n "${LOG_FILE:-}" ] && [ -f "$LOG_FILE" ]; then
  DURATION=$(python3 -c "
import re, sys
from datetime import datetime

try:
    with open('$LOG_FILE', 'r') as f:
        lines = f.readlines()

    # Find first and last timestamps in JSONL log
    first_ts = last_ts = None
    ts_pat = re.compile(r'\"timestamp\":\"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})')
    for line in lines[:50]:
        m = ts_pat.search(line)
        if m and not first_ts:
            first_ts = m.group(1)
            break
    for line in reversed(lines[-50:]):
        m = ts_pat.search(line)
        if m:
            last_ts = m.group(1)
            break

    if first_ts and last_ts:
        t1 = datetime.fromisoformat(first_ts)
        t2 = datetime.fromisoformat(last_ts)
        print(int((t2 - t1).total_seconds()))
    else:
        print(999)  # Can't determine — assume not truncated
except Exception:
    print(999)
" 2>/dev/null || echo 999)
fi

# Check: duration < 180 seconds (3 minutes)
if [ "$DURATION" -ge 180 ]; then
  exit 0
fi

# Check: 0 commits in this session
COMMITS=$(cd "$DIR" && git log --oneline --since="$(date -d '5 minutes ago' -Iseconds 2>/dev/null || date -v-5M -Iseconds 2>/dev/null || echo '2000-01-01')" 2>/dev/null | grep -cv 'auto-snapshot' || echo 0)
if [ "$COMMITS" -gt 0 ]; then
  exit 0
fi

# Find assigned work-queue item
ASSIGNED_ID=""
if [ -n "${LOG_FILE:-}" ] && [ -f "$LOG_FILE" ]; then
  ASSIGNED_ID=$(grep -oP 'wq-\d+' "$LOG_FILE" | head -1 || true)
fi

if [ -z "$ASSIGNED_ID" ]; then
  echo "$(date -Iseconds) s=${SESSION_NUM:-?} truncated (${DURATION}s, 0 commits) but no assigned item found" >> "$RECOVERY_LOG"
  exit 0
fi

# Check if item is still not done — if it was completed, no recovery needed
ITEM_STATUS=$(node -e "
  const q = JSON.parse(require('fs').readFileSync('$DIR/work-queue.json', 'utf8'));
  const item = q.queue && q.queue.find(i => i.id === '$ASSIGNED_ID');
  console.log(item ? item.status : 'not_found');
" 2>/dev/null || echo "not_found")

if [ "$ITEM_STATUS" = "done" ] || [ "$ITEM_STATUS" = "not_found" ]; then
  echo "$(date -Iseconds) s=${SESSION_NUM:-?} truncated (${DURATION}s) but $ASSIGNED_ID is already $ITEM_STATUS — no recovery needed" >> "$RECOVERY_LOG"
  exit 0
fi

# Re-queue: ensure item status is "pending" so next B session picks it up
node -e "
  const fs = require('fs');
  const path = '$DIR/work-queue.json';
  const q = JSON.parse(fs.readFileSync(path, 'utf8'));
  const item = q.queue && q.queue.find(i => i.id === '$ASSIGNED_ID');
  if (item && item.status !== 'done') {
    const prevStatus = item.status;
    item.status = 'pending';
    if (!item.notes) item.notes = '';
    item.notes += ' [truncation-recovery s${SESSION_NUM:-?}: was ' + prevStatus + ', ${DURATION}s, re-queued]';
    fs.writeFileSync(path, JSON.stringify(q, null, 2));
    console.log('recovered');
  } else {
    console.log('skip');
  }
" 2>/dev/null

echo "$(date -Iseconds) s=${SESSION_NUM:-?} RECOVERED: $ASSIGNED_ID truncated after ${DURATION}s with 0 commits — re-queued as pending" >> "$RECOVERY_LOG"
