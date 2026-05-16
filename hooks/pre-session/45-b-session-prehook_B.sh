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
# Checks 2-4: Consolidated runner (wq-1006, d079 deliverable 2)
#   Single node process runs queue-title-lint, stuck items, pipeline nudge.
#   Runner produces pre-formatted .summary text; shell just echoes it.
#   Refactored: wq-1020 (d080) — eliminated ~30 lines of jq extraction.
###############################################################################
run_consolidated_checks() {
  RUNNER_OUTPUT=$(node "$DIR/b-prehook-runner.mjs" "${SESSION_NUM:-0}" "$DIR" "$WORK_QUEUE" "$HIST" 2>/dev/null) || {
    echo "b-prehook-runner: failed, falling back to skip"
    return 0
  }

  # Echo pre-formatted summary (title lint, stuck items, pipeline nudge)
  SUMMARY=$(echo "$RUNNER_OUTPUT" | jq -r '.summary // ""')
  [ -n "$SUMMARY" ] && echo "$SUMMARY"

  # Append stuck-items nudge text to compliance-nudge.txt if present
  STUCK_NUDGE=$(echo "$RUNNER_OUTPUT" | jq -r '.stuck_nudge // ""')
  [ -n "$STUCK_NUDGE" ] && echo "$STUCK_NUDGE" >> "$OUTPUT"
}

###############################################################################
# Check 5: Knowledge auto-retire (wq-1024, d081 deliverable 2)
#   Retires stale patterns (>90 days, not consensus) every 20 B sessions.
###############################################################################
run_knowledge_auto_retire() {
  local sn="${SESSION_NUM:-0}"
  # Run every 20 sessions (session num mod 20 == 0), or if SESSION_NUM is 0 (unknown)
  if [[ "$sn" -eq 0 ]] || (( sn % 20 != 0 )); then
    return 0
  fi
  node "$DIR/knowledge-auto-retire.mjs" 2>/dev/null || {
    echo "knowledge-auto-retire: failed (non-fatal)"
  }
}

###############################################################################
# Run all checks
###############################################################################

check_truncation_detect
run_consolidated_checks
run_knowledge_auto_retire

exit 0
