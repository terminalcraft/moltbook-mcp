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
#   R#313: Logic extracted to hooks/lib/truncation-recovery.mjs
###############################################################################
check_truncation_recovery() {
  if [ -z "${LOG_FILE:-}" ] || [ ! -f "$LOG_FILE" ]; then
    return 0
  fi

  # Count commits in this session (git ops are cheaper in bash)
  local COMMITS
  COMMITS=$(cd "$MCP_DIR" && git log --oneline --since="$(date -d '5 minutes ago' -Iseconds 2>/dev/null || date -v-5M -Iseconds 2>/dev/null || echo '2000-01-01')" 2>/dev/null | grep -cv 'auto-snapshot' || echo 0)

  # R#313: delegate duration check, item lookup, and re-queue to truncation-recovery.mjs
  local OUTPUT
  OUTPUT=$(node "$MCP_DIR/hooks/lib/truncation-recovery.mjs" "$SESSION_NUM" "$LOG_FILE" "$WQ" "$AUDIT_LOG" "$COMMITS" 2>/dev/null) || true
  if [ -n "$OUTPUT" ]; then
    echo "$OUTPUT"
    # Log recovery events to the dedicated recovery log
    if echo "$OUTPUT" | grep -q "RECOVERED\|truncated"; then
      echo "$OUTPUT" >> "$RECOVERY_LOG"
    fi
  fi
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
    return 0
  fi

  # Check credentials exist
  if [[ ! -f "$MCP_DIR/clawsta-credentials.json" ]]; then
    echo "clawsta-autopost: skip — no credentials"
    return 0
  fi

  echo "clawsta-autopost: publishing (B session $B_COUNT, interval=$CLAWSTA_INTERVAL)..."
  local RESULT
  RESULT=$(cd "$MCP_DIR" && node clawsta-publish.mjs 2>&1) || {
    echo "clawsta-autopost: FAILED — $RESULT"
    return 0
  }

  local POST_ID
  POST_ID=$(echo "$RESULT" | grep -oP '"postId":\s*"\K[^"]+' || echo "unknown")
  local CHART_TYPE
  CHART_TYPE=$(echo "$RESULT" | grep -oP '"chartType":\s*"\K[^"]+' || echo "unknown")

  echo "clawsta-autopost: OK — posted $CHART_TYPE chart (ID: $POST_ID)"
}

###############################################################################
# Check 5: Probe timing budget alert (wq-710, extended wq-715)
#   Read both liveness-timing.json and service-liveness-timing.json
#   Warn if latest wallMs exceeds budget or slow platforms detected
###############################################################################
PROBE_TIMING_THRESHOLD=8000

check_probe_timing_budget() {
  local ENGAGEMENT_FILE="$STATE_DIR/liveness-timing.json"
  local SERVICE_FILE="$STATE_DIR/service-liveness-timing.json"
  local ANY_DATA=0

  for TIMING_FILE in "$ENGAGEMENT_FILE" "$SERVICE_FILE"; do
    if [[ ! -f "$TIMING_FILE" ]]; then
      continue
    fi
    ANY_DATA=1

    local LABEL
    LABEL=$(basename "$TIMING_FILE" .json)

    local WALL_MS SESSION_ID
    WALL_MS=$(jq '.entries[-1].wallMs // 0' "$TIMING_FILE" 2>/dev/null || echo 0)
    SESSION_ID=$(jq -r '.entries[-1].session // "?"' "$TIMING_FILE" 2>/dev/null || echo "?")

    if (( WALL_MS > PROBE_TIMING_THRESHOLD )); then
      echo "probe-timing($LABEL): WARN — ${WALL_MS}ms exceeds ${PROBE_TIMING_THRESHOLD}ms (s${SESSION_ID})"
      echo "WARN: Probe timing $LABEL ${WALL_MS}ms > ${PROBE_TIMING_THRESHOLD}ms budget (s${SESSION_ID})" >> "$AUDIT_LOG" 2>/dev/null
    else
      echo "probe-timing($LABEL): OK — ${WALL_MS}ms (s${SESSION_ID})"
    fi
  done

  if (( ANY_DATA == 0 )); then
    echo "probe-timing: skip — no timing data"
  fi
}

###############################################################################
# Check 6: Manifest drift detection (wq-856)
#   Compare hook count on disk vs manifest. If mismatched, regenerate.
#   Prevents recurring drift when B sessions create hooks via Write.
###############################################################################
check_manifest_drift() {
  local MANIFEST="$MCP_DIR/hooks/manifest.json"
  if [[ ! -f "$MANIFEST" ]]; then
    echo "manifest-drift: WARN — manifest.json missing, regenerating"
    (cd "$MCP_DIR" && SESSION_NUM="$SESSION_NUM" node generate-hook-manifest.mjs 2>/dev/null) || true
    return 0
  fi

  local MANIFEST_COUNT DISK_COUNT
  MANIFEST_COUNT=$(jq '.total' "$MANIFEST" 2>/dev/null || echo 0)
  DISK_COUNT=0
  for phase_dir in "$MCP_DIR/hooks/pre-session" "$MCP_DIR/hooks/post-session" "$MCP_DIR/hooks/mode-transform"; do
    if [[ -d "$phase_dir" ]]; then
      DISK_COUNT=$((DISK_COUNT + $(ls "$phase_dir"/*.sh 2>/dev/null | wc -l)))
    fi
  done

  if [[ "$DISK_COUNT" -ne "$MANIFEST_COUNT" ]]; then
    echo "manifest-drift: FIXING — disk=$DISK_COUNT manifest=$MANIFEST_COUNT, regenerating"
    (cd "$MCP_DIR" && SESSION_NUM="$SESSION_NUM" node generate-hook-manifest.mjs 2>/dev/null) || true
    # Stage the updated manifest so auto-commit picks it up
    (cd "$MCP_DIR" && git add hooks/manifest.json 2>/dev/null) || true
  else
    echo "manifest-drift: OK — $DISK_COUNT hooks"
  fi
}

###############################################################################
# Check 7: Commit count cost awareness (wq-868)
#   Log warning when B session exceeds 4-commit budget threshold.
#   Sessions with 5+ commits consistently cost >$2.00.
###############################################################################
COMMIT_BUDGET=4

check_commit_count() {
  local BOUNDARY
  BOUNDARY=$(cd "$MCP_DIR" && git log --oneline --all --grep="auto-snapshot" -1 --format="%H" 2>/dev/null || true)

  local COMMIT_COUNT=0
  if [ -n "$BOUNDARY" ]; then
    COMMIT_COUNT=$(cd "$MCP_DIR" && git rev-list --count "${BOUNDARY}..HEAD" 2>/dev/null || echo 0)
  else
    COMMIT_COUNT=$(cd "$MCP_DIR" && git log --oneline -20 2>/dev/null | grep -cv 'auto-snapshot' || echo 0)
  fi

  if (( COMMIT_COUNT > COMMIT_BUDGET )); then
    echo "commit-budget: WARN — s${SESSION_NUM} made ${COMMIT_COUNT} commits (budget: ${COMMIT_BUDGET}). Likely >$2.00 session."
    echo "WARN: B s${SESSION_NUM} exceeded commit budget: ${COMMIT_COUNT} commits (limit ${COMMIT_BUDGET})" >> "$AUDIT_LOG" 2>/dev/null
  elif (( COMMIT_COUNT == COMMIT_BUDGET )); then
    echo "commit-budget: AT LIMIT — s${SESSION_NUM} made ${COMMIT_COUNT} commits (budget: ${COMMIT_BUDGET})"
  else
    echo "commit-budget: OK — ${COMMIT_COUNT} commits"
  fi
}

###############################################################################
# Run all checks sequentially
###############################################################################

check_checkpoint_clear
check_truncation_recovery
check_pipeline_gate
check_commit_count
check_clawsta_autopost
check_probe_timing_budget
check_manifest_drift

exit 0
