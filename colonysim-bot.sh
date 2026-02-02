#!/usr/bin/env bash
# ColonySim auto-player — adaptive strategy based on tick history
# Run via cron every 10 minutes or from heartbeat.sh
# Usage: ./colonysim-bot.sh [--dry-run]

set -euo pipefail

KEY_FILE="$HOME/.colonysim-key"
STATE_FILE="$HOME/.config/moltbook/colonysim-state.json"
HISTORY_FILE="$HOME/.config/moltbook/colonysim-history.json"
HEARTBEAT_FILE="$HOME/.config/moltbook/colonysim-heartbeat.json"
ERROR_COUNT_FILE="$HOME/.config/moltbook/colonysim-errors"
BASE="https://colonysim.ctxly.app/api/v1"

mkdir -p "$HOME/.config/moltbook"

if [[ ! -f "$KEY_FILE" ]]; then
  echo "ERROR: No ColonySim key at $KEY_FILE"
  echo "{\"status\":\"error\",\"error\":\"no-key\",\"ts\":\"$(date -Is)\"}" > "$HEARTBEAT_FILE"
  exit 1
fi

API_KEY=$(cat "$KEY_FILE")
DRY_RUN="${1:-}"

# Get current game state
STATE=$(curl -sf --max-time 15 "$BASE/tick" -H "Authorization: Bearer $API_KEY" 2>/dev/null) || {
  echo "ERROR: Failed to fetch game state"
  # Track consecutive errors
  ERRS=0; [[ -f "$ERROR_COUNT_FILE" ]] && ERRS=$(cat "$ERROR_COUNT_FILE")
  ERRS=$((ERRS + 1)); echo "$ERRS" > "$ERROR_COUNT_FILE"
  echo "{\"status\":\"error\",\"error\":\"fetch-failed\",\"consecutive_errors\":$ERRS,\"ts\":\"$(date -Is)\"}" > "$HEARTBEAT_FILE"
  exit 1
}

# Reset error counter on successful fetch
echo "0" > "$ERROR_COUNT_FILE"

TICK=$(echo "$STATE" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['tick'])")
HAS_SUBMITTED=$(echo "$STATE" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['hasSubmitted'])")
FOOD=$(echo "$STATE" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['colony']['food'])")
HEALTH=$(echo "$STATE" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; ms=[m for m in d['members'] if m['name']=='moltbook']; print(ms[0]['health'] if ms else 'unknown')")
WEATHER=$(echo "$STATE" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['colony']['weather'])")
MEMBERS=$(echo "$STATE" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['data']['members']))")
# Check for pending votes
HAS_VOTE=$(echo "$STATE" | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
votes = d.get('votes') or d.get('pendingVotes') or []
print('true' if votes else 'false')
" 2>/dev/null || echo "false")

echo "Tick $TICK | food=$FOOD health=$HEALTH weather=$WEATHER members=$MEMBERS vote=$HAS_VOTE submitted=$HAS_SUBMITTED"

if [[ "$HAS_SUBMITTED" == "True" ]] || [[ "$HAS_SUBMITTED" == "true" ]]; then
  echo "Already submitted for tick $TICK, skipping."
  echo "{\"tick\":$TICK,\"food\":$FOOD,\"health\":\"$HEALTH\",\"weather\":\"$WEATHER\",\"action\":\"none\",\"ts\":\"$(date -Is)\"}" > "$STATE_FILE"
  echo "{\"status\":\"ok\",\"tick\":$TICK,\"food\":$FOOD,\"health\":\"$HEALTH\",\"weather\":\"$WEATHER\",\"action\":\"already-submitted\",\"members\":$MEMBERS,\"ts\":\"$(date -Is)\"}" > "$HEARTBEAT_FILE"
  exit 0
fi

# Load tick history for trend analysis
mkdir -p "$(dirname "$HISTORY_FILE")"
if [[ ! -f "$HISTORY_FILE" ]]; then
  echo "[]" > "$HISTORY_FILE"
fi

# Compute food trend from last 3 ticks
FOOD_TREND=$(python3 -c "
import json
try:
    h = json.load(open('$HISTORY_FILE'))
    recent = [e['food'] for e in h[-3:] if 'food' in e]
    if len(recent) >= 2:
        trend = recent[-1] - recent[0]
        print('rising' if trend > 2 else 'falling' if trend < -2 else 'stable')
    else:
        print('unknown')
except: print('unknown')
")

echo "Food trend: $FOOD_TREND"

# Adaptive decision logic
ACTION="GATHER"
REASON="default"

if [[ "$HAS_VOTE" == "true" ]]; then
  ACTION="VOTE"
  REASON="pending colony vote"
elif [[ "$FOOD" -lt 3 ]]; then
  ACTION="GATHER"
  REASON="critical food ($FOOD)"
elif [[ "$HEALTH" != "unknown" ]] && [[ "$HEALTH" -lt 30 ]]; then
  ACTION="REST"
  REASON="critical health ($HEALTH)"
elif [[ "$WEATHER" == "storm" ]] || [[ "$WEATHER" == "blizzard" ]]; then
  ACTION="REST"
  REASON="bad weather ($WEATHER)"
elif [[ "$HEALTH" != "unknown" ]] && [[ "$HEALTH" -lt 60 ]]; then
  ACTION="REST"
  REASON="low health ($HEALTH)"
elif [[ "$FOOD" -lt 8 ]]; then
  ACTION="GATHER"
  REASON="low food ($FOOD)"
elif [[ "$FOOD_TREND" == "falling" ]] && [[ "$FOOD" -lt 15 ]]; then
  ACTION="GATHER"
  REASON="food declining ($FOOD, trend=$FOOD_TREND)"
elif [[ "$FOOD" -ge 20 ]]; then
  ACTION="EXPLORE"
  REASON="food surplus ($FOOD), exploring"
elif [[ "$FOOD" -ge 12 ]] && [[ "$FOOD_TREND" != "falling" ]]; then
  ACTION="EXPLORE"
  REASON="stable food ($FOOD, trend=$FOOD_TREND), exploring"
else
  ACTION="GATHER"
  REASON="steady gathering (food=$FOOD, trend=$FOOD_TREND)"
fi

echo "Decision: $ACTION ($REASON)"

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "DRY RUN — not submitting"
  exit 0
fi

# Submit action
RESULT=$(curl -sf -X POST "$BASE/tick/submit" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"action\": \"$ACTION\"}" 2>/dev/null) || {
  echo "ERROR: Failed to submit action"
  exit 1
}

echo "Submitted: $RESULT"

# Save current state
echo "{\"tick\":$TICK,\"food\":$FOOD,\"health\":\"$HEALTH\",\"weather\":\"$WEATHER\",\"action\":\"$ACTION\",\"reason\":\"$REASON\",\"ts\":\"$(date -Is)\"}" > "$STATE_FILE"

# Write heartbeat status (consumed by pre-session hook)
echo "{\"status\":\"ok\",\"tick\":$TICK,\"food\":$FOOD,\"health\":\"$HEALTH\",\"weather\":\"$WEATHER\",\"action\":\"$ACTION\",\"members\":$MEMBERS,\"ts\":\"$(date -Is)\"}" > "$HEARTBEAT_FILE"

# Append to history (capped at 50 entries)
python3 -c "
import json
h = json.load(open('$HISTORY_FILE'))
h.append({'tick':$TICK,'food':$FOOD,'health':'$HEALTH','weather':'$WEATHER','action':'$ACTION'})
h = h[-50:]
json.dump(h, open('$HISTORY_FILE','w'))
"
