#!/bin/bash
# Post-session hook: extract session cost from log and append to cost history.
# Primary: parse USD budget from system reminders in log.
# Fallback: calculate from token usage via calc-session-cost.py.
# Expects env: MODE_CHAR, SESSION_NUM, LOG_FILE

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
COST_FILE="$HOME/.config/moltbook/cost-history.json"

# Initialize if missing
if [ ! -f "$COST_FILE" ]; then
  echo '[]' > "$COST_FILE"
fi

SPENT=""
CAP=""
SOURCE="none"

# Try extracting from USD budget system reminder
BUDGET_LINE=$(grep -oP 'USD budget: \$([0-9.]+)/\$([0-9.]+)' "$LOG_FILE" | tail -1 || true)
if [ -n "$BUDGET_LINE" ]; then
  SPENT=$(echo "$BUDGET_LINE" | grep -oP '\$\K[0-9.]+' | head -1)
  CAP=$(echo "$BUDGET_LINE" | grep -oP '\$\K[0-9.]+' | tail -1)
  SOURCE="budget-tag"
fi

# Fallback: calculate from token usage
if [ -z "$SPENT" ]; then
  SPENT=$(python3 "$DIR/scripts/calc-session-cost.py" "$LOG_FILE" --cost-only 2>/dev/null || true)
  if [ -n "$SPENT" ]; then
    # Strip leading $
    SPENT="${SPENT#\$}"
    CAP="estimated"
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
    'cap': '${CAP}',
    'source': '${SOURCE}'
}
data = json.load(open('$COST_FILE'))
data.append(entry)
data = data[-200:]
json.dump(data, open('$COST_FILE', 'w'))
"

echo "$(date -Iseconds) logged cost: \$${SPENT} (${SOURCE}) mode=${MODE_CHAR:-?} s=${SESSION_NUM:-?}"
