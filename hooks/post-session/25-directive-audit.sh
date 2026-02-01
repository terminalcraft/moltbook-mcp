#!/bin/bash
# Post-session: audit which directives were followed/ignored using Sonnet
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

# Extract a condensed version of the session log
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

Return ONLY valid JSON with NO markdown formatting, NO code fences, NO explanation. Just the raw JSON object:
{\"session_type\":\"$MODE_CHAR\",\"date\":\"$(date +%Y-%m-%d)\",\"session_num\":${SESSION_NUM:-0},\"directives_followed\":[\"short name of directive\"],\"directives_ignored\":[\"short name of directive\"],\"notes\":\"one sentence summary\"}

SESSION DIRECTIVES:
$SESSION_CONTENT

AGENT ACTIVITY SUMMARY:
$LOG_SUMMARY"

# Call Sonnet via claude CLI
RAW_RESULT=$(claude -p "$PROMPT" --model claude-opus-4-5-20251101 --max-budget-usd 0.05 --output-format text 2>/dev/null) || exit 0

# Extract JSON — strip markdown code fences and whitespace
RESULT=$(echo "$RAW_RESULT" | python3 -c "
import sys, json, re
text = sys.stdin.read().strip()
# Remove markdown code fences
text = re.sub(r'^\`\`\`(?:json)?\s*', '', text)
text = re.sub(r'\s*\`\`\`\s*$', '', text)
text = text.strip()
# Validate it's JSON
obj = json.loads(text)
print(json.dumps(obj))
" 2>/dev/null) || exit 0

[ -z "$RESULT" ] && exit 0

# Append to tracking file
python3 -c "
import json, sys
result = json.loads(sys.stdin.read())
try:
    data = json.load(open('$TRACKING_FILE'))
except:
    data = {'version': 1, 'audits': []}
data['audits'].append(result)
data['audits'] = data['audits'][-50:]
json.dump(data, open('$TRACKING_FILE', 'w'), indent=2)
" <<< "$RESULT" 2>/dev/null || exit 0
