#!/bin/bash
# Post-session hook: write structured JSON outcome per session.
# Reads cost from cost-history.json (written by 15-cost-pipeline.sh which runs first).
# Expects env: MODE_CHAR, SESSION_NUM, LOG_FILE, SESSION_EXIT, SESSION_OUTCOME, R_FOCUS, B_FOCUS

set -euo pipefail

OUTCOMES_FILE="$HOME/.config/moltbook/session-outcomes.json"
COST_FILE="$HOME/.config/moltbook/cost-history.json"

# Initialize if missing
if [ ! -f "$OUTCOMES_FILE" ]; then
  echo '[]' > "$OUTCOMES_FILE"
fi

# Extract cost from cost-history.json (last entry matching this session)
COST=$(python3 -c "
import json
try:
    data = json.load(open('$COST_FILE'))
    matches = [e for e in data if e.get('session') == ${SESSION_NUM:-0}]
    print(matches[-1]['spent'] if matches else 0)
except: print(0)
" 2>/dev/null || echo 0)

# Count commits made during session (from git log timestamps vs session log)
COMMITS=0
if [ -f "$LOG_FILE" ]; then
  COMMITS=$(grep -c '"type":"tool_result".*git commit\|committed.*files changed\|create mode' "$LOG_FILE" 2>/dev/null || echo 0)
  # Fallback: count commit hashes in log
  if [ "$COMMITS" = "0" ]; then
    COMMITS=$(grep -oP '\b[0-9a-f]{7,40}\b.*\bcommit\b|\bcommit\b.*\b[0-9a-f]{7,40}\b' "$LOG_FILE" 2>/dev/null | wc -l || echo 0)
  fi
fi

# Extract files changed from git (last N commits from this session)
FILES_CHANGED=""
if command -v git &>/dev/null; then
  cd "$(dirname "$0")/../.." 2>/dev/null || true
  FILES_CHANGED=$(git diff --name-only HEAD~3 HEAD 2>/dev/null | sort -u | tr '\n' ',' | sed 's/,$//' || echo "")
fi

# Determine focus
FOCUS=""
[ -n "${B_FOCUS:-}" ] && FOCUS="$B_FOCUS"
[ -n "${R_FOCUS:-}" ] && FOCUS="$R_FOCUS"

# Write entry
python3 -c "
import json, sys
from datetime import datetime

entry = {
    'timestamp': datetime.now().isoformat(),
    'session': int('${SESSION_NUM:-0}'),
    'mode': '${MODE_CHAR:-?}',
    'focus': '${FOCUS}' or None,
    'exit_code': int('${SESSION_EXIT:-1}'),
    'outcome': '${SESSION_OUTCOME:-unknown}',
    'cost_usd': float('${COST}'),
    'files_changed': '${FILES_CHANGED}'.split(',') if '${FILES_CHANGED}' else [],
}

data = json.load(open('$OUTCOMES_FILE'))
data.append(entry)
# Keep last 200 sessions
data = data[-200:]
json.dump(data, open('$OUTCOMES_FILE', 'w'), indent=2)
"

echo "$(date -Iseconds) structured outcome logged: s=${SESSION_NUM:-?} ${SESSION_OUTCOME:-?} \$${COST}"
