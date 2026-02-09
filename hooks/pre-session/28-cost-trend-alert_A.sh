#!/bin/bash
# Pre-session hook (A sessions only): B session cost trend monitor (wq-485)
# Outputs cost trend alerts for audit sessions to consume.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"

result=$(node "$DIR/b-cost-trend.mjs" --json 2>/dev/null) || exit 0

status=$(echo "$result" | jq -r '.status')
avg=$(echo "$result" | jq -r '.recentAvg')
trend=$(echo "$result" | jq -r '.trendPct')
high=$(echo "$result" | jq -r '.highCount')

case "$status" in
  critical)
    echo "[cost-trend] CRITICAL: B session avg \$$avg exceeds \$3.00. Trend: ${trend}%. High-cost: ${high}/10."
    ;;
  warn)
    echo "[cost-trend] WARN: B session avg \$$avg exceeds \$2.50 or ${high}+ sessions >$3. Trend: ${trend}%."
    ;;
  watch)
    echo "[cost-trend] WATCH: B session cost trend +${trend}% (avg \$$avg). ${high} high-cost sessions."
    ;;
  *)
    echo "[cost-trend] OK: B session avg \$$avg, trend ${trend}%."
    ;;
esac
