#!/bin/bash
# 08-cost-forecast-inject.sh — Inject cost forecast into session context
#
# Runs cost-forecast.mjs and outputs a compact summary for the session prompt.
# B sessions see their assigned task's effort classification and predicted cost.
# Other session types see their type's historical average.
#
# Non-fatal: always exits 0.
#
# Created: B#402 s1410 (wq-536)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${MODE_CHAR:-B}"

# Only run for B/E/R/A sessions
[[ "$MODE" =~ ^[BERA]$ ]] || exit 0

# Run cost-forecast.mjs with timeout to prevent stalling pre-session
FORECAST=$(timeout 5 node "$DIR/cost-forecast.mjs" --json --type "$MODE" 2>/dev/null) || exit 0
[ -n "$FORECAST" ] || exit 0

# Extract key fields
PREDICTED=$(echo "$FORECAST" | jq -r '.nextSession.predictedCost // empty' 2>/dev/null) || exit 0
CONFIDENCE=$(echo "$FORECAST" | jq -r '.nextSession.confidence // empty' 2>/dev/null) || exit 0
TOP_EFFORT=$(echo "$FORECAST" | jq -r '.nextSession.topItem.effort // "unknown"' 2>/dev/null) || exit 0
TOP_ID=$(echo "$FORECAST" | jq -r '.nextSession.topItem.id // "none"' 2>/dev/null) || exit 0
QUEUE_COUNT=$(echo "$FORECAST" | jq -r '.pendingQueue.count // 0' 2>/dev/null) || exit 0
QUEUE_TOTAL=$(echo "$FORECAST" | jq -r '.pendingQueue.totalEstimatedCost // 0' 2>/dev/null) || exit 0

[ -n "$PREDICTED" ] || exit 0

# Output compact summary to stderr (captured by heartbeat.sh)
if [ "$MODE" = "B" ] && [ "$TOP_ID" != "none" ]; then
  echo "[cost-forecast] Predicted: \$$PREDICTED ($CONFIDENCE) | Task $TOP_ID effort: $TOP_EFFORT | Queue: $QUEUE_COUNT items, ~\$$QUEUE_TOTAL to drain"
else
  echo "[cost-forecast] Predicted $MODE cost: \$$PREDICTED ($CONFIDENCE) | Queue: $QUEUE_COUNT pending"
fi

exit 0
