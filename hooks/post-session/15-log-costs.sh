#!/bin/bash
# Post-session hook: calculate session cost from token usage and append to cost history.
# Uses calc-session-cost.py to parse token counts from stream-json logs.
# Expects env: MODE_CHAR, SESSION_NUM, LOG_FILE

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
COST_FILE="$HOME/.config/moltbook/cost-history.json"

# Initialize if missing
if [ ! -f "$COST_FILE" ]; then
  echo '[]' > "$COST_FILE"
fi

SPENT=""
SOURCE="none"
AGENT_COST_FILE="$HOME/.config/moltbook/session-cost.txt"

# Priority 1: Agent-reported cost (includes subagent costs, written by agent at session end)
if [ -f "$AGENT_COST_FILE" ]; then
  AGENT_SPENT=$(grep -oP 'BUDGET_SPENT=\K[0-9.]+' "$AGENT_COST_FILE" 2>/dev/null || true)
  if [ -n "$AGENT_SPENT" ] && [ "$AGENT_SPENT" != "0" ]; then
    SPENT="$AGENT_SPENT"
    SOURCE="agent-reported"
  fi
  rm -f "$AGENT_COST_FILE"  # consume the file
fi

# Priority 2: Token-based calculation from stream-json log
if [ -z "$SPENT" ] || [ "$SPENT" = "0.0000" ]; then
  COST_JSON=$(python3 "$DIR/scripts/calc-session-cost.py" "$LOG_FILE" --json 2>/dev/null || true)
  if [ -n "$COST_JSON" ]; then
    SPENT=$(echo "$COST_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{d[\"cost_usd\"]:.4f}')" 2>/dev/null || true)
    SOURCE="token-calc"
  fi
fi

if [ -z "$SPENT" ] || [ "$SPENT" = "0.0000" ]; then
  echo "$(date -Iseconds) no cost data found in log" >&2
  exit 0
fi

# Append entry
python3 -c "
import json, sys
entry = {
    'date': '$(date -Iseconds)',
    'session': int('${SESSION_NUM:-0}'),
    'mode': '${MODE_CHAR:-?}',
    'spent': float('${SPENT}'),
    'source': '${SOURCE}'
}
data = json.load(open('$COST_FILE'))
data.append(entry)
data = data[-200:]
json.dump(data, open('$COST_FILE', 'w'))
"

echo "$(date -Iseconds) logged cost: \$${SPENT} (${SOURCE}) mode=${MODE_CHAR:-?} s=${SESSION_NUM:-?}"
