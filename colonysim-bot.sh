#!/usr/bin/env bash
# ColonySim auto-player — submits actions each tick
# Run via cron every 10 minutes or from heartbeat.sh
# Usage: ./colonysim-bot.sh [--dry-run]

set -euo pipefail

KEY_FILE="$HOME/.colonysim-key"
STATE_FILE="$HOME/.config/moltbook/colonysim-state.json"
BASE="https://colonysim.ctxly.app/api/v1"

if [[ ! -f "$KEY_FILE" ]]; then
  echo "ERROR: No ColonySim key at $KEY_FILE"
  exit 1
fi

API_KEY=$(cat "$KEY_FILE")
DRY_RUN="${1:-}"

# Get current game state
STATE=$(curl -sf "$BASE/tick" -H "Authorization: Bearer $API_KEY" 2>/dev/null) || {
  echo "ERROR: Failed to fetch game state"
  exit 1
}

TICK=$(echo "$STATE" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['tick'])")
HAS_SUBMITTED=$(echo "$STATE" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['hasSubmitted'])")
FOOD=$(echo "$STATE" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['colony']['food'])")
HEALTH=$(echo "$STATE" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; ms=[m for m in d['members'] if m['name']=='moltbook']; print(ms[0]['health'] if ms else 'unknown')")
WEATHER=$(echo "$STATE" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['colony']['weather'])")

echo "Tick $TICK | food=$FOOD health=$HEALTH weather=$WEATHER submitted=$HAS_SUBMITTED"

if [[ "$HAS_SUBMITTED" == "True" ]] || [[ "$HAS_SUBMITTED" == "true" ]]; then
  echo "Already submitted for tick $TICK, skipping."
  # Save state for diagnostics
  echo "{\"tick\":$TICK,\"food\":$FOOD,\"health\":\"$HEALTH\",\"weather\":\"$WEATHER\",\"action\":\"none\",\"ts\":\"$(date -Is)\"}" > "$STATE_FILE"
  exit 0
fi

# Decision logic: prioritize survival
ACTION="GATHER"
REASON="default"

if [[ "$FOOD" -lt 5 ]]; then
  ACTION="GATHER"
  REASON="low food ($FOOD)"
elif [[ "$HEALTH" != "unknown" ]] && [[ "$HEALTH" -lt 50 ]]; then
  ACTION="REST"
  REASON="low health ($HEALTH)"
elif [[ "$WEATHER" == "storm" ]] || [[ "$WEATHER" == "blizzard" ]]; then
  ACTION="REST"
  REASON="bad weather ($WEATHER)"
elif [[ "$FOOD" -ge 15 ]]; then
  ACTION="EXPLORE"
  REASON="food surplus ($FOOD), exploring"
else
  ACTION="GATHER"
  REASON="steady gathering"
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

# Save state
mkdir -p "$(dirname "$STATE_FILE")"
echo "{\"tick\":$TICK,\"food\":$FOOD,\"health\":\"$HEALTH\",\"weather\":\"$WEATHER\",\"action\":\"$ACTION\",\"reason\":\"$REASON\",\"ts\":\"$(date -Is)\"}" > "$STATE_FILE"
