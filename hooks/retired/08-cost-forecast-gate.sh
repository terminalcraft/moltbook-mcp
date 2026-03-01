#!/bin/bash
# 08-cost-forecast-gate.sh — Pre-session cost forecast gate
#
# Warns when predicted session cost exceeds 80% of the session type's budget cap.
# Uses cost-forecast.mjs for prediction and compares against known budget caps.
# This is a GATE, not a blocker — it emits a prominent warning the agent sees.
#
# Non-fatal: always exits 0. Warning is informational.
#
# Created: B#435 (wq-607)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${MODE_CHAR:-B}"

# Only run for known session types
[[ "$MODE" =~ ^[BERA]$ ]] || exit 0

# Budget caps by session type (must match heartbeat.sh definitions)
declare -A BUDGET_CAPS
BUDGET_CAPS[B]=10
BUDGET_CAPS[E]=5
BUDGET_CAPS[R]=5
BUDGET_CAPS[A]=3

CAP="${BUDGET_CAPS[$MODE]:-10}"
THRESHOLD_PCT=80
THRESHOLD=$(echo "$CAP * $THRESHOLD_PCT / 100" | bc -l 2>/dev/null | xargs printf "%.2f" 2>/dev/null) || exit 0

# Run cost-forecast.mjs to get predicted cost
FORECAST=$(timeout 5 node "$DIR/cost-forecast.mjs" --json --type "$MODE" 2>/dev/null) || exit 0
[ -n "$FORECAST" ] || exit 0

PREDICTED=$(echo "$FORECAST" | jq -r '.nextSession.predictedCost // empty' 2>/dev/null) || exit 0
[ -n "$PREDICTED" ] || exit 0

# Compare predicted cost against threshold
EXCEEDS=$(echo "$PREDICTED > $THRESHOLD" | bc -l 2>/dev/null) || exit 0

if [ "$EXCEEDS" = "1" ]; then
  CONFIDENCE=$(echo "$FORECAST" | jq -r '.nextSession.confidence // "unknown"' 2>/dev/null) || CONFIDENCE="unknown"
  TOP_ID=$(echo "$FORECAST" | jq -r '.nextSession.topItem.id // "none"' 2>/dev/null) || TOP_ID="none"
  TOP_EFFORT=$(echo "$FORECAST" | jq -r '.nextSession.topItem.effort // "unknown"' 2>/dev/null) || TOP_EFFORT="unknown"

  echo "⚠ [COST-GATE] Predicted cost \$$PREDICTED exceeds ${THRESHOLD_PCT}% of $MODE budget cap (\$$CAP). Threshold: \$$THRESHOLD. Confidence: $CONFIDENCE."
  if [ "$TOP_ID" != "none" ]; then
    echo "  Task: $TOP_ID (effort: $TOP_EFFORT). Consider splitting or deferring if effort is heavy."
  fi
  echo "  ACTION: Monitor spend closely. Stop picking up new items if cost approaches \$$CAP."
fi

exit 0
