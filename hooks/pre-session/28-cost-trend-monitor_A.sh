#!/bin/bash
# Pre-session hook (A sessions only): Cost trend monitor for B and R sessions
# Consolidates 28-cost-trend-alert_A.sh (wq-485) and 28-r-cost-trend_A.sh (wq-601)
# Merged: B#483 (wq-727)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# --- B session cost trend ---
b_result=$(node "$DIR/b-cost-trend.mjs" --json 2>/dev/null) || b_result=""
if [ -n "$b_result" ]; then
  b_status=$(echo "$b_result" | jq -r '.status')
  b_avg=$(echo "$b_result" | jq -r '.recentAvg')
  b_trend=$(echo "$b_result" | jq -r '.trendPct')
  b_high=$(echo "$b_result" | jq -r '.highCount')

  case "$b_status" in
    critical)
      echo "[cost-trend] CRITICAL: B session avg \$$b_avg exceeds \$3.00. Trend: ${b_trend}%. High-cost: ${b_high}/10."
      ;;
    warn)
      echo "[cost-trend] WARN: B session avg \$$b_avg exceeds \$2.50 or ${b_high}+ sessions >$3. Trend: ${b_trend}%."
      ;;
    watch)
      echo "[cost-trend] WATCH: B session cost trend +${b_trend}% (avg \$$b_avg). ${b_high} high-cost sessions."
      ;;
    *)
      echo "[cost-trend] OK: B session avg \$$b_avg, trend ${b_trend}%."
      ;;
  esac
fi

# --- R session cost trend ---
r_result=$(node "$DIR/r-cost-monitor.mjs" --json 2>/dev/null) || r_result=""
if [ -n "$r_result" ]; then
  r_status=$(echo "$r_result" | jq -r '.status')
  r_avg=$(echo "$r_result" | jq -r '.postR252Avg')
  r_monitored=$(echo "$r_result" | jq -r '.monitored')
  r_remaining=$(echo "$r_result" | jq -r '.remaining')

  case "$r_status" in
    ALERT)
      echo "[r-cost-trend] ALERT: R sessions avg \$$r_avg — 3+ consecutive above \$2.50. Investigate R#252 scope creep."
      ;;
    MONITORING)
      echo "[r-cost-trend] MONITORING: R sessions avg \$$r_avg ($r_monitored sampled, $r_remaining remaining). wq-601 active."
      ;;
    RESOLVED)
      echo "[r-cost-trend] RESOLVED: R session cost trend acceptable (avg \$$r_avg). wq-601 can be closed."
      ;;
  esac
fi
