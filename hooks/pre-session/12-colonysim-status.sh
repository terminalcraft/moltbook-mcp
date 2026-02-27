#!/bin/bash
# Pre-session hook: inject colonysim game state into session context

HEARTBEAT_FILE="$HOME/.config/moltbook/colonysim-heartbeat.json"
LOG_DIR="$HOME/.config/moltbook/logs"

if [[ ! -f "$HEARTBEAT_FILE" ]]; then
  echo "COLONYSIM: no heartbeat — bot may not have run yet"
  exit 0
fi

# wq-705: Replaced python3 with jq for JSON parsing
LAST=$(jq -r '
  if .status != "ok" then
    "ERROR: \(.error // "unknown") (consecutive: \(.consecutive_errors // 0))"
  else
    "tick=\(.tick // "?") food=\(.food // "?") health=\(.health // "?") weather=\(.weather // "?") members=\(.members // "?") last=\(.action // "?")"
  end
' "$HEARTBEAT_FILE" 2>/dev/null)

# Calculate age from timestamp
TS=$(jq -r '.ts // empty' "$HEARTBEAT_FILE" 2>/dev/null)
AGE_STR="unknown"
if [ -n "$TS" ]; then
  TS_EPOCH=$(date -d "$TS" +%s 2>/dev/null || echo 0)
  NOW_EPOCH=$(date +%s)
  if [ "$TS_EPOCH" -gt 0 ]; then
    AGE_MIN=$(( (NOW_EPOCH - TS_EPOCH) / 60 ))
    AGE_STR="${AGE_MIN}m ago"
  fi
fi
LAST="$LAST [$AGE_STR]"

echo "COLONYSIM: $LAST"

# Warn on recent errors in log
if [[ -f "$LOG_DIR/colonysim.log" ]]; then
  ERRORS=$(tail -20 "$LOG_DIR/colonysim.log" | grep -c "ERROR" 2>/dev/null || true)
  ERRORS="${ERRORS:-0}"
  if [[ "$ERRORS" -gt 0 ]]; then
    echo "COLONYSIM: $ERRORS errors in recent log tail"
  fi
fi
