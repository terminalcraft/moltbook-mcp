#!/bin/bash
# Pre-hook: Session outcome feedback + rotation tuning pipeline
#
# Phase 1: Analyzes last 10 outcomes per session type from outcomes.log.
#           Prints warnings if timeout/error rate exceeds 50%.
# Phase 2: Runs rotation-tuner.py to evaluate rotation efficiency and
#           writes recommendation to rotation-tuning.json. On R sessions,
#           if a rotation change is recommended, auto-applies it.
#
# Originally: wq-016 (outcome feedback only)
# Restructured R#100: integrated rotation-tuner into live pipeline.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTCOMES_LOG="$HOME/.config/moltbook/logs/outcomes.log"
SESSION_TYPE="${MODE_CHAR:-B}"
STATE_DIR="$HOME/.config/moltbook"
TUNING_STATE="$STATE_DIR/rotation-tuning.json"

# ── Phase 1: Outcome health check ──

# wq-705: Replaced Phase 1 python3 with bash+awk
if [ -f "$OUTCOMES_LOG" ]; then
  # Filter to current session type's last 10 outcomes
  TYPE_LINES=$(grep " ${SESSION_TYPE} s=" "$OUTCOMES_LOG" | tail -10)
  LINE_COUNT=$(echo "$TYPE_LINES" | grep -c . 2>/dev/null || echo 0)

  if [ "$LINE_COUNT" -ge 5 ]; then
    TOTAL=$(echo "$TYPE_LINES" | grep -oP 'outcome=\K\S+' | wc -l)
    TIMEOUTS=$(echo "$TYPE_LINES" | grep -oP 'outcome=\K\S+' | grep -c '^timeout$' || echo 0)
    ERRORS=$(echo "$TYPE_LINES" | grep -oP 'outcome=\K\S+' | grep -c '^error$' || echo 0)
    SUCCESSES=$(echo "$TYPE_LINES" | grep -oP 'outcome=\K\S+' | grep -c '^success$' || echo 0)

    if [ "$TOTAL" -gt 0 ]; then
      TIMEOUT_PCT=$((TIMEOUTS * 100 / TOTAL))
      ERROR_PCT=$((ERRORS * 100 / TOTAL))

      if [ "$TIMEOUT_PCT" -gt 50 ]; then
        AVG_DUR=$(echo "$TYPE_LINES" | grep -oP 'dur=\K\d+' | awk '{s+=$1; n++} END {if(n>0) printf "%d", s/n; else print 0}')
        echo "OUTCOME_WARNING: ${SESSION_TYPE} sessions have ${TIMEOUT_PCT}% timeout rate (last ${TOTAL}). Avg duration: ${AVG_DUR}s. Reduce scope this session."
      elif [ "$ERROR_PCT" -gt 50 ]; then
        echo "OUTCOME_WARNING: ${SESSION_TYPE} sessions have ${ERROR_PCT}% error rate (last ${TOTAL}). Check infrastructure before starting work."
      else
        echo "OUTCOME_FEEDBACK: ${SESSION_TYPE} sessions healthy — ${SUCCESSES}/${TOTAL} success rate"
      fi
    fi
  fi
fi

# ── Phase 2: Rotation tuning ──

TUNER="$DIR/rotation-tuner.py"
if [ ! -f "$TUNER" ]; then
  exit 0
fi

# Run tuner in JSON mode and capture output
TUNER_OUTPUT=$(python3 "$TUNER" --json 2>/dev/null) || exit 0

# Write tuning state for session consumption
echo "$TUNER_OUTPUT" > "$TUNING_STATE"

# wq-705: Replaced python3 JSON extraction with jq
CHANGED=$(echo "$TUNER_OUTPUT" | jq -r '.recommendation.changed' 2>/dev/null) || exit 0
NEW_PATTERN=$(echo "$TUNER_OUTPUT" | jq -r '.recommendation.pattern' 2>/dev/null) || exit 0
REASON=$(echo "$TUNER_OUTPUT" | jq -r '.recommendation.reason' 2>/dev/null) || exit 0
CURRENT=$(echo "$TUNER_OUTPUT" | jq -r '.recommendation.current' 2>/dev/null) || exit 0

if [ "$CHANGED" = "True" ]; then
  if [ "$SESSION_TYPE" = "R" ]; then
    # R sessions auto-apply rotation changes — they own self-evolution
    python3 "$TUNER" --apply > /dev/null 2>&1
    echo "ROTATION_TUNED: Applied $CURRENT → $NEW_PATTERN ($REASON)"
    echo "$(date -Iseconds) rotation-tuner auto-applied: $CURRENT → $NEW_PATTERN ($REASON)" >> "$HOME/.config/moltbook/logs/selfmod.log"
  else
    # Non-R sessions: surface as advisory
    echo "ROTATION_ADVISORY: Tuner recommends $CURRENT → $NEW_PATTERN ($REASON). Will auto-apply next R session."
  fi
else
  echo "ROTATION_STATUS: $CURRENT optimal — no change needed"
fi
