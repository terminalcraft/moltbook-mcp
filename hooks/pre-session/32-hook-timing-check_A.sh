#!/bin/bash
# 32-hook-timing-check_A.sh — Report slow hooks and regressions for A sessions
# Created: B#528 (wq-827)
#
# Runs hook-timing-report.mjs and writes structured results to hook-timing-audit.json
# for the audit report to consume. Flags hooks exceeding 3000ms threshold.
#
# Non-blocking: issues are reported but don't prevent session start.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
OUTPUT_FILE="$STATE_DIR/hook-timing-audit.json"

# Run hook-timing-report with --json --last 10
RAW=$(node "$DIR/hook-timing-report.mjs" --json --last 10 2>/dev/null) || {
  echo '{"checked":"'"$(date -Iseconds)"'","session":'"${SESSION_NUM:-0}"',"error":"hook-timing-report.mjs failed","slow_count":0,"worst_offender":null}' > "$OUTPUT_FILE"
  echo "[hook-timing] ERROR: hook-timing-report.mjs failed"
  exit 0
}

# Extract summary fields
SLOW_COUNT=$(echo "$RAW" | jq '.regressions')
TOTAL=$(echo "$RAW" | jq '.total_hooks')

# Find worst offender (highest p95)
WORST=$(echo "$RAW" | jq -r '
  if (.hooks | length) > 0 then
    .hooks[0] | "\(.hook) (\(.phase)) p95=\(.p95)ms avg=\(.avg)ms"
  else
    "none"
  end
')
# Build degrading list (hooks with trend == "degrading" AND p95 > 1000ms)
DEGRADING=$(echo "$RAW" | jq '[.hooks[] | select(.trend == "degrading" and .p95 > 1000)]')
DEGRADING_COUNT=$(echo "$DEGRADING" | jq 'length')

# Write structured output for audit consumption
echo "$RAW" | jq --argjson session "${SESSION_NUM:-0}" --arg checked "$(date -Iseconds)" \
  --argjson degrading_count "$DEGRADING_COUNT" '{
    checked: $checked,
    session: $session,
    threshold_ms: .threshold_ms,
    sessions_analyzed: .sessions_analyzed,
    total_hooks: .total_hooks,
    slow_count: .regressions,
    worst_offender: (if (.hooks | length) > 0 then {
      hook: .hooks[0].hook,
      phase: .hooks[0].phase,
      p95: .hooks[0].p95,
      avg: .hooks[0].avg,
      trend: .hooks[0].trend
    } else null end),
    degrading_count: $degrading_count,
    regressions: [.hooks[] | select(.regression) | {hook, phase, p95, avg, trend}]
  }' > "$OUTPUT_FILE"

# Output summary for session prompt
if [ "$SLOW_COUNT" -gt 0 ]; then
  echo "[hook-timing] $SLOW_COUNT/$TOTAL hooks exceed ${THRESHOLD_MS:-3000}ms threshold. Worst: $WORST"
  if [ "$DEGRADING_COUNT" -gt 0 ]; then
    echo "[hook-timing] $DEGRADING_COUNT hook(s) degrading with P95 >1000ms"
  fi
else
  echo "[hook-timing] OK: 0/$TOTAL hooks exceed threshold"
fi

exit 0
