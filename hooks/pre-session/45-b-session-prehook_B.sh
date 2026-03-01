#!/bin/bash
# 45-b-session-prehook_B.sh — Consolidated B-session pre-hook dispatcher
#
# Merges 4 individual B-session pre-hooks into a single dispatcher.
# Reduces hook count and eliminates repeated file loading.
#
# Replaces:
#   45-truncation-detect_B.sh  (wq-192, wq-203)
#   46-queue-title-lint_B.sh   (wq-600)
#   46-stuck-items_B.sh        (wq-197)
#   49-pipeline-nudge_B.sh     (wq-696, wq-706)
#
# Created: B#490 (wq-729)

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
HIST="$STATE_DIR/session-history.txt"
OUTPUT="$STATE_DIR/compliance-nudge.txt"
CHECKPOINT="$STATE_DIR/b-session-checkpoint.json"
WORK_QUEUE="$DIR/work-queue.json"

###############################################################################
# Check 1: Truncation detection (was 45-truncation-detect_B.sh)
#   Detect potentially truncated B sessions and stale checkpoints
###############################################################################
check_truncation_detect() {
  # Check for stale checkpoint first (wq-203)
  if [[ -f "$CHECKPOINT" ]]; then
    CP_TS=$(jq -r '.timestamp // empty' "$CHECKPOINT" 2>/dev/null)
    CHECKPOINT_AGE=0
    if [[ -n "$CP_TS" ]]; then
      CP_EPOCH=$(date -d "$CP_TS" +%s 2>/dev/null || echo 0)
      NOW_EPOCH=$(date +%s)
      if [[ "$CP_EPOCH" -gt 0 ]]; then
        CHECKPOINT_AGE=$(( (NOW_EPOCH - CP_EPOCH) / 60 ))
      fi
    fi

    if [[ "$CHECKPOINT_AGE" -ge 2 ]]; then
      TASK_ID=$(jq -r '.task_id // "unknown"' "$CHECKPOINT" 2>/dev/null)
      INTENT=$(jq -r '.intent // "" | .[:60]' "$CHECKPOINT" 2>/dev/null)
      SESS=$(jq -r '.session // 0' "$CHECKPOINT" 2>/dev/null)

      {
        echo ""
        echo "## CHECKPOINT RECOVERY — previous session left breadcrumb"
        echo "s$SESS was working on: $TASK_ID"
        echo "Intent: $INTENT"
        echo "Age: ${CHECKPOINT_AGE}m"
        echo ""
        echo "Run: node session-checkpoint.mjs read  # Full details"
        echo "Run: node session-checkpoint.mjs clear # After recovery"
      } >> "$OUTPUT"

      echo "truncation-detect: found checkpoint from s$SESS ($TASK_ID, ${CHECKPOINT_AGE}m old)"
    fi
  fi

  [[ ! -f "$HIST" ]] && return 0

  CANDIDATES=()
  while IFS= read -r line; do
    [[ "$line" != *"mode=B"* ]] && continue

    SESS=$(echo "$line" | grep -oP 's=\K\d+')
    NOTE=$(echo "$line" | grep -oP 'note: \K.*$')
    DUR=$(echo "$line" | grep -oP 'dur=\K[^ ]+')

    TRUNCATED=false
    [[ ${#NOTE} -lt 10 ]] && TRUNCATED=true
    [[ "$NOTE" == "(commit)" || "$NOTE" == "(none)" ]] && TRUNCATED=true
    [[ "$NOTE" =~ [Pp]artial|WIP|[Tt]runcat|[Ii]ncomplete ]] && TRUNCATED=true
    [[ "$DUR" == ~* ]] && TRUNCATED=true
    if [[ ! "$NOTE" =~ [\.\!\?\)\"]$ ]] && [[ ! "$NOTE" =~ :[[:space:]] ]]; then
      TRUNCATED=true
    fi

    if [[ "$TRUNCATED" == true ]]; then
      CANDIDATES+=("s$SESS: $NOTE")
    fi
  done < "$HIST"

  if [[ ${#CANDIDATES[@]} -gt 0 ]]; then
    RECENT=("${CANDIDATES[@]: -3}")

    {
      echo ""
      echo "## TRUNCATION RECOVERY — potentially incomplete B sessions"
      echo "Recent B sessions with incomplete notes may need follow-up:"
      for c in "${RECENT[@]}"; do
        echo "  - $c"
      done
      echo ""
      echo "Check git log for WIP commits. Resume if work was partial."
    } >> "$OUTPUT"

    echo "truncation-detect: found ${#RECENT[@]} candidate(s) for recovery"
  fi
}

###############################################################################
# Check 2: Queue title lint (was 46-queue-title-lint_B.sh)
#   Advisory lint of queue item titles for quality
###############################################################################
check_queue_title_lint() {
  output=$(node "$DIR/queue-title-lint.mjs" 2>/dev/null) || true
  if [ -n "$output" ]; then
    echo "$output"
  fi
}

###############################################################################
# Check 3: Stuck items detection (was 46-stuck-items_B.sh)
#   Flags items in-progress for 5+ B sessions
###############################################################################
check_stuck_items() {
  [[ ! -f "$WORK_QUEUE" ]] && return 0
  [[ ! -f "$HIST" ]] && return 0

  CURRENT_SESSION=$(tail -1 "$HIST" | grep -oP 's=\K\d+' || echo 0)
  [[ "$CURRENT_SESSION" -eq 0 ]] && return 0

  STUCK_ITEMS=()

  while IFS= read -r line; do
    ID=$(echo "$line" | jq -r '.id // empty' 2>/dev/null)
    [[ -z "$ID" ]] && continue

    TITLE=$(echo "$line" | jq -r '.title // empty' 2>/dev/null)
    CREATED_SESSION=$(echo "$line" | jq -r '.created_session // 0' 2>/dev/null)
    NOTES=$(echo "$line" | jq -r '.notes // empty' 2>/dev/null)

    START_SESSION=0
    [[ "$CREATED_SESSION" -gt 0 ]] && START_SESSION=$CREATED_SESSION

    if [[ "$START_SESSION" -eq 0 && -n "$NOTES" ]]; then
      S_REF=$(echo "$NOTES" | grep -oP '\bs\K\d{3,}' | head -1)
      [[ -n "$S_REF" ]] && START_SESSION=$S_REF
    fi

    [[ "$START_SESSION" -eq 0 ]] && continue

    SESSIONS_ELAPSED=$((CURRENT_SESSION - START_SESSION))
    B_SESSIONS_APPROX=$((SESSIONS_ELAPSED * 60 / 100))

    if [[ "$B_SESSIONS_APPROX" -ge 5 ]]; then
      STUCK_ITEMS+=("$ID: $TITLE (started ~s$START_SESSION, ~$B_SESSIONS_APPROX B sessions)")
    fi
  done < <(jq -c '.queue[] | select(.status == "in-progress")' "$WORK_QUEUE" 2>/dev/null)

  if [[ ${#STUCK_ITEMS[@]} -gt 0 ]]; then
    {
      echo ""
      echo "## STUCK ITEMS — in-progress for 5+ B sessions"
      echo "These work-queue items may need attention or closure:"
      for item in "${STUCK_ITEMS[@]}"; do
        echo "  - $item"
      done
      echo ""
      echo "Either complete, block (with blocker reason), or retire if no longer relevant."
    } >> "$OUTPUT"

    echo "stuck-items: found ${#STUCK_ITEMS[@]} potentially stuck item(s)"
  fi
}

###############################################################################
# Check 4: Pipeline nudge (was 49-pipeline-nudge_B.sh)
#   Advisory reminder for pipeline gate compliance
###############################################################################
check_pipeline_nudge() {
  THRESHOLD="${PIPELINE_NUDGE_THRESHOLD:-3}"

  stats=$(node -e "
const stats = JSON.parse(require('child_process').execSync('SESSION_NUM=${SESSION_NUM:-0} node $DIR/audit-stats.mjs', {encoding:'utf8'}));
const g = stats.b_pipeline_gate || {};
const v = g.violation_count || 0;
const rate = g.rate || 'N/A';
process.stdout.write(JSON.stringify({v, rate}));
" 2>/dev/null) || return 0

  violations=$(echo "$stats" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(String(d.v))" 2>/dev/null || echo 0)
  rate=$(echo "$stats" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.rate)" 2>/dev/null || echo "?/?")

  if [ -n "$violations" ] && [ "$violations" -ge "$THRESHOLD" ] 2>/dev/null; then
    echo ""
    echo "PIPELINE GATE COMPLIANCE: $rate ($violations violations)"
    echo "OBLIGATION: Add >=1 new pending queue item OR brainstorming idea BEFORE marking task done."
    echo ""
  fi
}

###############################################################################
# Run all checks sequentially
###############################################################################

check_truncation_detect
check_queue_title_lint
check_stuck_items
check_pipeline_nudge

exit 0
