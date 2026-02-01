#!/bin/bash
# Post-session: audit which directives were followed/ignored using Haiku
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
TRACKING_FILE="$DIR/directive-tracking.json"

# Need LOG_FILE and MODE_CHAR from environment (set by heartbeat.sh)
[ -z "${LOG_FILE:-}" ] && exit 0
[ -z "${MODE_CHAR:-}" ] && exit 0
[ -f "$LOG_FILE" ] || exit 0

# Map mode to session file
case "$MODE_CHAR" in
  R) SESSION_FILE="$DIR/SESSION_REFLECT.md" ;;
  B) SESSION_FILE="$DIR/SESSION_BUILD.md" ;;
  E) SESSION_FILE="$DIR/SESSION_ENGAGE.md" ;;
  H) SESSION_FILE="$DIR/SESSION_HOUSEKEEP.md" ;;
  L) SESSION_FILE="$DIR/SESSION_LEARN.md" ;;
  *) SESSION_FILE="$DIR/SESSION_ENGAGE.md" ;;
esac
[ -f "$SESSION_FILE" ] || exit 0

SESSION_CONTENT=$(cat "$SESSION_FILE")

# Extract a condensed version of the session log (last 200 lines of text output, skip raw JSON)
# The log is stream-json, extract assistant text blocks
LOG_SUMMARY=$(python3 -c "
import json, sys
lines = open('$LOG_FILE').readlines()
texts = []
for l in lines:
    try:
        obj = json.loads(l)
        if obj.get('type') == 'assistant' and obj.get('message', {}).get('content'):
            for b in obj['message']['content']:
                if b.get('type') == 'text' and b.get('text'):
                    texts.append(b['text'][:300])
                if b.get('type') == 'tool_use':
                    texts.append(f\"[tool: {b.get('name','')} {str(b.get('input',''))[:100]}]\")
    except: pass
print('\n'.join(texts[-80:]))
" 2>/dev/null) || exit 0

[ -z "$LOG_SUMMARY" ] && exit 0

PROMPT="You are auditing an autonomous agent session. Below are the SESSION DIRECTIVES the agent was supposed to follow, and a SUMMARY OF WHAT THE AGENT ACTUALLY DID.

Return ONLY valid JSON (no markdown, no explanation) in this exact format:
{\"session_type\":\"$MODE_CHAR\",\"date\":\"$(date +%Y-%m-%d)\",\"session_num\":${SESSION_NUM:-0},\"directives_followed\":[\"short name of directive\"],\"directives_ignored\":[\"short name of directive\"],\"notes\":\"one sentence summary\"}

SESSION DIRECTIVES:
$SESSION_CONTENT

AGENT ACTIVITY SUMMARY:
$LOG_SUMMARY"

# Call Haiku via claude CLI (cheap, ~0.01 per audit)
RESULT=$(claude -p "$PROMPT" --model claude-3-5-haiku-20241022 --max-budget-usd 0.05 --output-format text 2>/dev/null) || exit 0

# Validate it's JSON
echo "$RESULT" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null || exit 0

# Append to tracking file
python3 -c "
import json, sys
result = json.loads('''$RESULT''')
try:
    data = json.load(open('$TRACKING_FILE'))
except:
    data = {'version': 1, 'audits': []}
data['audits'].append(result)
# Keep last 50 audits
data['audits'] = data['audits'][-50:]
json.dump(data, open('$TRACKING_FILE', 'w'), indent=2)
" 2>/dev/null || exit 0
