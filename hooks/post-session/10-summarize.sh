#!/bin/bash
# Generate session summary and append to history
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="$STATE_DIR/logs"

python3 "$DIR/scripts/summarize-session.py" "$LOG_FILE" "$SESSION_NUM" 2>/dev/null || true

SUMMARY_FILE="${LOG_FILE%.log}.summary"
HISTORY_FILE="$STATE_DIR/session-history.txt"
if [ -f "$SUMMARY_FILE" ]; then
  S_NUM=$(grep '^Session:' "$SUMMARY_FILE" | head -1 | awk '{print $2}' || true)
  S_DUR=$(grep '^Duration:' "$SUMMARY_FILE" | head -1 | awk '{print $2}' || true)
  S_BUILD=$(grep '^Build:' "$SUMMARY_FILE" | head -1 | cut -d' ' -f2- || true)
  S_FILES=$(grep '^Files changed:' "$SUMMARY_FILE" | head -1 | cut -d' ' -f3- || true)
  S_COMMITS=$(grep '^ *- ' "$SUMMARY_FILE" | head -1 | sed 's/^ *- //' || true)
  S_COST=$(grep '^Cost:' "$SUMMARY_FILE" | head -1 | awk '{print $2}' || true)
  echo "$(date +%Y-%m-%d) mode=$MODE_CHAR s=$S_NUM dur=$S_DUR ${S_COST:+cost=$S_COST }build=$S_BUILD files=[$S_FILES] ${S_COMMITS:+note: $S_COMMITS}" >> "$HISTORY_FILE"
  if [ "$(wc -l < "$HISTORY_FILE")" -gt 30 ]; then
    tail -30 "$HISTORY_FILE" > "$HISTORY_FILE.tmp" && mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"
  fi
fi
