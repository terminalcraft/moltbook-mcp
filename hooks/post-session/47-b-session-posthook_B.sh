#!/bin/bash
# 47-b-session-posthook_B.sh — Consolidated B-session post-hook dispatcher
#
# Merges 3 individual B-session hooks into a single dispatcher.
# Reduces hook count and eliminates repeated state loading.
#
# Replaces:
#   47-checkpoint-clear_B.sh   (wq-203)
#   48-truncation-recovery_B.sh (wq-636)
#   49-pipeline-gate_B.sh      (R#270)
#
# Created: B#461 (wq-670)
set -euo pipefail

: "${SESSION_NUM:?SESSION_NUM required}"
: "${MODE_CHAR:?MODE_CHAR required}"

MCP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="$STATE_DIR/logs"
CHECKPOINT="$STATE_DIR/b-session-checkpoint.json"
RECOVERY_LOG="$LOG_DIR/truncation-recovery.log"
WQ="$MCP_DIR/work-queue.json"
BRAIN="$MCP_DIR/BRAINSTORMING.md"
AUDIT_LOG="$STATE_DIR/maintain-audit.txt"

mkdir -p "$LOG_DIR"

###############################################################################
# Check 1: Checkpoint clear (was 47-checkpoint-clear_B.sh)
#   Remove B session checkpoint on completion to avoid false alarms
###############################################################################
check_checkpoint_clear() {
  if [[ -f "$CHECKPOINT" ]]; then
    rm -f "$CHECKPOINT"
    echo "checkpoint-clear: removed b-session-checkpoint.json"
  fi
}

###############################################################################
# Check 2: Truncation recovery (was 48-truncation-recovery_B.sh)
#   Detect truncated B sessions (<3 min, 0 commits) and re-queue assigned item
###############################################################################
check_truncation_recovery() {
  # Compute duration from session log timestamps
  local DURATION=0
  if [ -n "${LOG_FILE:-}" ] && [ -f "$LOG_FILE" ]; then
    DURATION=$(python3 -c "
import re, sys
from datetime import datetime

try:
    with open('$LOG_FILE', 'r') as f:
        lines = f.readlines()

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
        print(999)
except Exception:
    print(999)
" 2>/dev/null || echo 999)
  fi

  # Not truncated if >= 3 minutes
  if [ "$DURATION" -ge 180 ]; then
    return
  fi

  # Check: 0 commits in this session
  local COMMITS
  COMMITS=$(cd "$MCP_DIR" && git log --oneline --since="$(date -d '5 minutes ago' -Iseconds 2>/dev/null || date -v-5M -Iseconds 2>/dev/null || echo '2000-01-01')" 2>/dev/null | grep -cv 'auto-snapshot' || echo 0)
  if [ "$COMMITS" -gt 0 ]; then
    return
  fi

  # Find assigned work-queue item
  local ASSIGNED_ID=""
  if [ -n "${LOG_FILE:-}" ] && [ -f "$LOG_FILE" ]; then
    ASSIGNED_ID=$(grep -oP 'wq-\d+' "$LOG_FILE" | head -1 || true)
  fi

  if [ -z "$ASSIGNED_ID" ]; then
    echo "$(date -Iseconds) s=${SESSION_NUM} truncated (${DURATION}s, 0 commits) but no assigned item found" >> "$RECOVERY_LOG"
    return
  fi

  # Check if item is still not done
  local ITEM_STATUS
  ITEM_STATUS=$(node -e "
    const q = JSON.parse(require('fs').readFileSync('$WQ', 'utf8'));
    const item = q.queue && q.queue.find(i => i.id === '$ASSIGNED_ID');
    console.log(item ? item.status : 'not_found');
  " 2>/dev/null || echo "not_found")

  if [ "$ITEM_STATUS" = "done" ] || [ "$ITEM_STATUS" = "not_found" ]; then
    echo "$(date -Iseconds) s=${SESSION_NUM} truncated (${DURATION}s) but $ASSIGNED_ID is already $ITEM_STATUS — no recovery needed" >> "$RECOVERY_LOG"
    return
  fi

  # Re-queue: ensure item status is "pending"
  node -e "
    const fs = require('fs');
    const q = JSON.parse(fs.readFileSync('$WQ', 'utf8'));
    const item = q.queue && q.queue.find(i => i.id === '$ASSIGNED_ID');
    if (item && item.status !== 'done') {
      const prevStatus = item.status;
      item.status = 'pending';
      if (!item.notes) item.notes = '';
      item.notes += ' [truncation-recovery s${SESSION_NUM}: was ' + prevStatus + ', ${DURATION}s, re-queued]';
      fs.writeFileSync('$WQ', JSON.stringify(q, null, 2));
      console.log('recovered');
    } else {
      console.log('skip');
    }
  " 2>/dev/null

  echo "$(date -Iseconds) s=${SESSION_NUM} RECOVERED: $ASSIGNED_ID truncated after ${DURATION}s with 0 commits — re-queued as pending" >> "$RECOVERY_LOG"
}

###############################################################################
# Check 3: Pipeline gate (was 49-pipeline-gate_B.sh)
#   Verify B session contributed to pipeline (brainstorming or queue items)
###############################################################################
check_pipeline_gate() {
  local BRAIN_CHANGED WQ_CHANGED PENDING

  BRAIN_CHANGED=$(cd "$MCP_DIR" && git diff HEAD~3..HEAD --name-only 2>/dev/null | grep -c "BRAINSTORMING.md" || true)
  WQ_CHANGED=$(cd "$MCP_DIR" && git diff HEAD~3..HEAD --name-only 2>/dev/null | grep -c "work-queue.json" || true)
  PENDING=$(jq '[.queue[] | select(.status == "pending")] | length' "$WQ" 2>/dev/null || echo 0)

  if [[ "$BRAIN_CHANGED" -eq 0 && "$WQ_CHANGED" -eq 0 ]]; then
    echo "pipeline-gate: WARN — B session s${SESSION_NUM} consumed queue without contributing. Pending: ${PENDING}"
    echo "WARN: B session s${SESSION_NUM} consumed queue without pipeline contribution (pending: ${PENDING})" >> "$AUDIT_LOG" 2>/dev/null
  elif [[ "$PENDING" -lt 5 ]]; then
    echo "pipeline-gate: WARN — pipeline low after B session s${SESSION_NUM}. Pending: ${PENDING} (target: >=5)"
    echo "WARN: Pipeline low after B#s${SESSION_NUM}: ${PENDING} pending (target >=5)" >> "$AUDIT_LOG" 2>/dev/null
  else
    echo "pipeline-gate: OK — pending: ${PENDING}"
  fi
}

###############################################################################
# Run all checks sequentially
###############################################################################

check_checkpoint_clear
check_truncation_recovery
check_pipeline_gate

exit 0
