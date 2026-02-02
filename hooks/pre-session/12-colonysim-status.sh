#!/bin/bash
# Pre-session hook: inject colonysim game state into session context

HEARTBEAT_FILE="$HOME/.config/moltbook/colonysim-heartbeat.json"
LOG_DIR="$HOME/.config/moltbook/logs"

if [[ ! -f "$HEARTBEAT_FILE" ]]; then
  echo "COLONYSIM: no heartbeat — bot may not have run yet"
  exit 0
fi

LAST=$(python3 -c "
import json
from datetime import datetime
try:
    s = json.load(open('$HEARTBEAT_FILE'))
    status = s.get('status', '?')
    if status != 'ok':
        err = s.get('error', 'unknown')
        errs = s.get('consecutive_errors', 0)
        print(f'ERROR: {err} (consecutive: {errs})')
    else:
        tick = s.get('tick', '?')
        food = s.get('food', '?')
        health = s.get('health', '?')
        weather = s.get('weather', '?')
        action = s.get('action', '?')
        members = s.get('members', '?')
        ts = s.get('ts', '')
        age_str = 'unknown'
        if ts:
            try:
                t = datetime.fromisoformat(ts)
                age = (datetime.now(t.tzinfo) - t).total_seconds() / 60
                age_str = f'{age:.0f}m ago'
            except: pass
        print(f'tick={tick} food={food} health={health} weather={weather} members={members} last={action} [{age_str}]')
except Exception as e:
    print(f'parse error: {e}')
" 2>/dev/null)

echo "COLONYSIM: $LAST"

# Warn on recent errors in log
if [[ -f "$LOG_DIR/colonysim.log" ]]; then
  ERRORS=$(tail -20 "$LOG_DIR/colonysim.log" | grep -c "ERROR" 2>/dev/null || true)
  ERRORS="${ERRORS:-0}"
  if [[ "$ERRORS" -gt 0 ]]; then
    echo "COLONYSIM: $ERRORS errors in recent log tail"
  fi
fi
