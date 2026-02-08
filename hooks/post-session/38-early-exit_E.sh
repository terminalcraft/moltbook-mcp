#!/bin/bash
# 38-early-exit_E.sh — Flag E sessions completing in <120s as anomalous (wq-423)
#
# E sessions averaging 3-5 minutes. Sessions under 2 minutes indicate
# early exit (platform errors, rate limits, truncation). Logs to a
# dedicated file for trend analysis by A sessions.
set -euo pipefail

STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="$STATE_DIR/logs"
EARLY_EXIT_LOG="$LOG_DIR/e-early-exits.log"

: "${SESSION_NUM:?SESSION_NUM required}"
: "${MODE_CHAR:?MODE_CHAR required}"

# Parse duration from summary file
SUMMARY_FILE="${LOG_FILE%.log}.summary"
if [ ! -f "$SUMMARY_FILE" ]; then
  exit 0
fi

S_DUR=$(grep '^Duration:' "$SUMMARY_FILE" | head -1 | awk '{print $2}' | tr -d '~' || echo "0m0s")

# Convert XmYs to seconds
MINUTES=0
SECONDS_PART=0
if [[ "$S_DUR" =~ ^([0-9]+)m ]]; then
  MINUTES="${BASH_REMATCH[1]}"
fi
if [[ "$S_DUR" =~ ([0-9]+)s ]]; then
  SECONDS_PART="${BASH_REMATCH[1]}"
fi
TOTAL_SECONDS=$((MINUTES * 60 + SECONDS_PART))

# Threshold: 120 seconds (2 minutes)
if [ "$TOTAL_SECONDS" -lt 120 ]; then
  mkdir -p "$LOG_DIR"
  echo "$(date -Iseconds) s=$SESSION_NUM dur=${S_DUR} (${TOTAL_SECONDS}s) — early exit detected" >> "$EARLY_EXIT_LOG"
fi
