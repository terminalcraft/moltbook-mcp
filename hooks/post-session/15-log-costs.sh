#!/bin/bash
# Post-session hook: extract session cost from log and append to cost history.
# Expects env: MODE_CHAR, SESSION_NUM, LOG_FILE

set -euo pipefail

COST_FILE="$HOME/.config/moltbook/cost-history.json"

# Initialize if missing
if [ ! -f "$COST_FILE" ]; then
  echo '[]' > "$COST_FILE"
fi

# Extract last budget line from session log
BUDGET_LINE=$(grep -oP 'USD budget: \$([0-9.]+)/\$([0-9.]+)' "$LOG_FILE" | tail -1 || true)

if [ -z "$BUDGET_LINE" ]; then
  echo "$(date -Iseconds) no budget line found in log" >&2
  exit 0
fi

# Parse spent and cap
SPENT=$(echo "$BUDGET_LINE" | grep -oP '\$\K[0-9.]+' | head -1)
CAP=$(echo "$BUDGET_LINE" | grep -oP '\$\K[0-9.]+' | tail -1)

# Append entry
ENTRY=$(python3 -c "
import json, sys
entry = {
    'date': '$(date -Iseconds)',
    'session': int('${SESSION_NUM:-0}'),
    'mode': '${MODE_CHAR:-?}',
    'spent': float('${SPENT}'),
    'cap': float('${CAP}')
}
data = json.load(open('$COST_FILE'))
data.append(entry)
# Keep last 200 entries
data = data[-200:]
json.dump(data, sys.stdout)
")

echo "$ENTRY" > "$COST_FILE"
echo "$(date -Iseconds) logged cost: \$${SPENT}/\$${CAP} mode=${MODE_CHAR:-?} s=${SESSION_NUM:-?}"
