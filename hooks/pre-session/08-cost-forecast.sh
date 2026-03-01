#!/bin/bash
# 08-cost-forecast.sh — Cost forecast: gate + context injection
#
# Runs cost-forecast.mjs once and:
# 1. Emits a compact cost summary for the session prompt (inject)
# 2. Warns if predicted cost exceeds 80% of the session type's budget cap (gate)
#
# Non-fatal: always exits 0.
#
# Consolidated from 08-cost-forecast-gate.sh + 08-cost-forecast-inject.sh
# Created: B#493 (wq-739, d070)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${MODE_CHAR:-B}"

# Only run for known session types
[[ "$MODE" =~ ^[BERA]$ ]] || exit 0

# Run cost-forecast.mjs once (shared by both gate and inject)
FORECAST=$(timeout 5 node "$DIR/cost-forecast.mjs" --json --type "$MODE" 2>/dev/null) || exit 0
[ -n "$FORECAST" ] || exit 0

# Extract key fields
PREDICTED=$(echo "$FORECAST" | jq -r '.nextSession.predictedCost // empty' 2>/dev/null) || exit 0
[ -n "$PREDICTED" ] || exit 0

CONFIDENCE=$(echo "$FORECAST" | jq -r '.nextSession.confidence // "unknown"' 2>/dev/null) || CONFIDENCE="unknown"
TOP_EFFORT=$(echo "$FORECAST" | jq -r '.nextSession.topItem.effort // "unknown"' 2>/dev/null) || TOP_EFFORT="unknown"
TOP_ID=$(echo "$FORECAST" | jq -r '.nextSession.topItem.id // "none"' 2>/dev/null) || TOP_ID="none"
QUEUE_COUNT=$(echo "$FORECAST" | jq -r '.pendingQueue.count // 0' 2>/dev/null) || QUEUE_COUNT="0"
QUEUE_TOTAL=$(echo "$FORECAST" | jq -r '.pendingQueue.totalEstimatedCost // 0' 2>/dev/null) || QUEUE_TOTAL="0"

# --- Inject: output compact summary ---
if [ "$MODE" = "B" ] && [ "$TOP_ID" != "none" ]; then
  echo "[cost-forecast] Predicted: \$$PREDICTED ($CONFIDENCE) | Task $TOP_ID effort: $TOP_EFFORT | Queue: $QUEUE_COUNT items, ~\$$QUEUE_TOTAL to drain"
else
  echo "[cost-forecast] Predicted $MODE cost: \$$PREDICTED ($CONFIDENCE) | Queue: $QUEUE_COUNT pending"
fi

# --- Gate: warn if predicted cost exceeds threshold ---
declare -A BUDGET_CAPS
BUDGET_CAPS[B]=10
BUDGET_CAPS[E]=5
BUDGET_CAPS[R]=5
BUDGET_CAPS[A]=3

CAP="${BUDGET_CAPS[$MODE]:-10}"
THRESHOLD_PCT=80
THRESHOLD=$(echo "$CAP * $THRESHOLD_PCT / 100" | bc -l 2>/dev/null | xargs printf "%.2f" 2>/dev/null) || exit 0

EXCEEDS=$(echo "$PREDICTED > $THRESHOLD" | bc -l 2>/dev/null) || exit 0

if [ "$EXCEEDS" = "1" ]; then
  echo "⚠ [COST-GATE] Predicted cost \$$PREDICTED exceeds ${THRESHOLD_PCT}% of $MODE budget cap (\$$CAP). Threshold: \$$THRESHOLD. Confidence: $CONFIDENCE."
  if [ "$TOP_ID" != "none" ]; then
    echo "  Task: $TOP_ID (effort: $TOP_EFFORT). Consider splitting or deferring if effort is heavy."
  fi
  echo "  ACTION: Monitor spend closely. Stop picking up new items if cost approaches \$$CAP."
fi

exit 0
