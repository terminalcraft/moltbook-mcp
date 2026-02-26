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
    DURATION=$(node -e "
      const fs = require('fs'), data = fs.readFileSync('$LOG_FILE', 'utf8');
      const pat = /\"timestamp\":\"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/g;
      const lines = data.split('\n');
      let first, last;
      for (const l of lines.slice(0, 50)) { const m = pat.exec(l); if (m) { first = m[1]; break; } }
      pat.lastIndex = 0;
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) { const m = pat.exec(lines[i]); if (m) { last = m[1]; break; } pat.lastIndex = 0; }
      if (first && last) { console.log(Math.floor((new Date(last) - new Date(first)) / 1000)); }
      else { console.log(999); }
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

  # Find the session boundary: last auto-snapshot commit before this session's work
  # This covers ALL session commits, not just last 3 (previous HEAD~3 missed contributions
  # in sessions with 4+ commits — root cause of false violations flagged in a161-1/wq-706)
  local BOUNDARY
  BOUNDARY=$(cd "$MCP_DIR" && git log --oneline --all --grep="auto-snapshot" -1 --format="%H" 2>/dev/null || true)
  local DIFF_RANGE="HEAD~3..HEAD"
  if [ -n "$BOUNDARY" ]; then
    DIFF_RANGE="${BOUNDARY}..HEAD"
  fi

  BRAIN_CHANGED=$(cd "$MCP_DIR" && git diff "$DIFF_RANGE" --name-only 2>/dev/null | grep -c "BRAINSTORMING.md" || true)
  WQ_CHANGED=$(cd "$MCP_DIR" && git diff "$DIFF_RANGE" --name-only 2>/dev/null | grep -c "work-queue.json" || true)
  PENDING=$(jq '[.queue[] | select(.status == "pending")] | length' "$WQ" 2>/dev/null || echo 0)

  if [[ "$BRAIN_CHANGED" -eq 0 && "$WQ_CHANGED" -eq 0 ]]; then
    echo "pipeline-gate: WARN — B session s${SESSION_NUM} consumed queue without contributing. Pending: ${PENDING}"
    echo "WARN: B session s${SESSION_NUM} consumed queue without pipeline contribution (pending: ${PENDING})" >> "$AUDIT_LOG" 2>/dev/null
    # Auto-remediation: append a pipeline-debt marker to BRAINSTORMING.md so next session replenishes
    if [[ -f "$BRAIN" ]]; then
      echo "- **[pipeline-debt from s${SESSION_NUM}]** (added ~s${SESSION_NUM}): Previous session consumed queue items without contributing replacements. Next B session should add a real idea here and remove this marker." >> "$BRAIN"
      echo "pipeline-gate: auto-remediation — added pipeline-debt marker to BRAINSTORMING.md"
    fi
  elif [[ "$PENDING" -lt 5 ]]; then
    echo "pipeline-gate: WARN — pipeline low after B session s${SESSION_NUM}. Pending: ${PENDING} (target: >=5)"
    echo "WARN: Pipeline low after B#s${SESSION_NUM}: ${PENDING} pending (target >=5)" >> "$AUDIT_LOG" 2>/dev/null
  else
    echo "pipeline-gate: OK — pending: ${PENDING}"
  fi
}

###############################################################################
# Check 4: Clawsta auto-publish (wq-671)
#   Post a data visualization to Clawsta every 10th B session.
#   Chart type round-robins via clawsta-publish-state.json.
###############################################################################
CLAWSTA_INTERVAL=10

check_clawsta_autopost() {
  # Count B sessions from session history to determine cadence
  local B_COUNT
  B_COUNT=$(grep -c 'mode=B' "$STATE_DIR/session-history.txt" 2>/dev/null || echo 0)

  if (( B_COUNT % CLAWSTA_INTERVAL != 0 )); then
    echo "clawsta-autopost: skip (B session $B_COUNT, next at $(( (B_COUNT / CLAWSTA_INTERVAL + 1) * CLAWSTA_INTERVAL )))"
    return
  fi

  # Check credentials exist
  if [[ ! -f "$MCP_DIR/clawsta-credentials.json" ]]; then
    echo "clawsta-autopost: skip — no credentials"
    return
  fi

  echo "clawsta-autopost: publishing (B session $B_COUNT, interval=$CLAWSTA_INTERVAL)..."
  local RESULT
  RESULT=$(cd "$MCP_DIR" && node clawsta-publish.mjs 2>&1) || {
    echo "clawsta-autopost: FAILED — $RESULT"
    return
  }

  local POST_ID
  POST_ID=$(echo "$RESULT" | grep -oP '"postId":\s*"\K[^"]+' || echo "unknown")
  local CHART_TYPE
  CHART_TYPE=$(echo "$RESULT" | grep -oP '"chartType":\s*"\K[^"]+' || echo "unknown")

  echo "clawsta-autopost: OK — posted $CHART_TYPE chart (ID: $POST_ID)"
}

###############################################################################
# Check 5: Probe timing budget alert (wq-710)
#   Read liveness-timing.json and warn if latest wallMs exceeds 8000ms
###############################################################################
PROBE_TIMING_THRESHOLD=8000

check_probe_timing_budget() {
  local TIMING_FILE="$STATE_DIR/liveness-timing.json"
  if [[ ! -f "$TIMING_FILE" ]]; then
    echo "probe-timing: skip — no timing data"
    return
  fi

  local WALL_MS SESSION_ID
  WALL_MS=$(jq '.entries[-1].wallMs // 0' "$TIMING_FILE" 2>/dev/null || echo 0)
  SESSION_ID=$(jq -r '.entries[-1].session // "?"' "$TIMING_FILE" 2>/dev/null || echo "?")

  if (( WALL_MS > PROBE_TIMING_THRESHOLD )); then
    echo "probe-timing: WARN — latest probe wall time ${WALL_MS}ms exceeds ${PROBE_TIMING_THRESHOLD}ms threshold (session s${SESSION_ID})"
    echo "WARN: Probe timing ${WALL_MS}ms > ${PROBE_TIMING_THRESHOLD}ms budget (s${SESSION_ID})" >> "$AUDIT_LOG" 2>/dev/null
  else
    echo "probe-timing: OK — ${WALL_MS}ms (threshold: ${PROBE_TIMING_THRESHOLD}ms)"
  fi
}

###############################################################################
# Run all checks sequentially
###############################################################################

check_checkpoint_clear
check_truncation_recovery
check_pipeline_gate
check_clawsta_autopost
check_probe_timing_budget

exit 0
