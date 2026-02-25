#!/bin/bash
# Pre-session hook (A sessions only): R session cost trend monitor (wq-601)
# Uses r-cost-monitor.mjs to track post-R#252 cost trend.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"

result=$(node "$DIR/r-cost-monitor.mjs" --json 2>/dev/null) || exit 0

status=$(echo "$result" | jq -r '.status')
avg=$(echo "$result" | jq -r '.postR252Avg')
monitored=$(echo "$result" | jq -r '.monitored')
remaining=$(echo "$result" | jq -r '.remaining')

case "$status" in
  ALERT)
    echo "[r-cost-trend] ALERT: R sessions avg \$$avg — 3+ consecutive above \$2.50. Investigate R#252 scope creep."
    ;;
  MONITORING)
    echo "[r-cost-trend] MONITORING: R sessions avg \$$avg ($monitored sampled, $remaining remaining). wq-601 active."
    ;;
  RESOLVED)
    echo "[r-cost-trend] RESOLVED: R session cost trend acceptable (avg \$$avg). wq-601 can be closed."
    ;;
esac
