#!/bin/bash
# Post-session: audit which directives were followed/ignored using Sonnet.
# Updates directive-tracking.json v2 schema (per-directive counters).
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
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
  *) SESSION_FILE="$DIR/SESSION_ENGAGE.md" ;;
esac
[ -f "$SESSION_FILE" ] || exit 0

SESSION_CONTENT=$(cat "$SESSION_FILE")

# Extract condensed session log
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

PROMPT="You are auditing an autonomous agent session. Below are the SESSION DIRECTIVES and a SUMMARY OF WHAT THE AGENT DID.

Return ONLY valid JSON: {\"followed\":[\"directive name\",...],\"ignored\":[{\"name\":\"directive name\",\"reason\":\"short reason\"},...]}

Use short consistent directive names (e.g. 'structural change', 'commit early and often', 'chatr engagement', 'moltbook voting').

SESSION DIRECTIVES:
$SESSION_CONTENT

AGENT ACTIVITY:
$LOG_SUMMARY"

RAW_RESULT=$(claude -p "$PROMPT" --model claude-sonnet-4-20250514 --max-budget-usd 0.03 --output-format text 2>/dev/null) || exit 0

# Parse and update v2 tracking file
python3 -c "
import json, sys, re

raw = sys.stdin.read().strip()
raw = re.sub(r'^\`\`\`(?:json)?\s*', '', raw)
raw = re.sub(r'\s*\`\`\`\s*$', '', raw)
audit = json.loads(raw.strip())

try:
    data = json.load(open('$TRACKING_FILE'))
except:
    data = {'version': 2, 'description': 'Per-directive compliance counters', 'directives': {}}

# Ensure v2
if data.get('version') != 2:
    data = {'version': 2, 'description': 'Per-directive compliance counters', 'directives': {}}

session = ${SESSION_NUM:-0}

for name in audit.get('followed', []):
    key = name.lower().strip()
    if key not in data['directives']:
        data['directives'][key] = {'followed': 0, 'ignored': 0, 'last_ignored_reason': None, 'last_session': 0}
    data['directives'][key]['followed'] += 1
    data['directives'][key]['last_session'] = session

for item in audit.get('ignored', []):
    if isinstance(item, str):
        key, reason = item.lower().strip(), 'unknown'
    else:
        key, reason = item['name'].lower().strip(), item.get('reason', 'unknown')
    if key not in data['directives']:
        data['directives'][key] = {'followed': 0, 'ignored': 0, 'last_ignored_reason': None, 'last_session': 0}
    data['directives'][key]['ignored'] += 1
    data['directives'][key]['last_ignored_reason'] = reason
    data['directives'][key]['last_session'] = session

json.dump(data, open('$TRACKING_FILE', 'w'), indent=2)
print(f'Updated {len(audit.get(\"followed\",[]))} followed, {len(audit.get(\"ignored\",[]))} ignored')
" <<< "$RAW_RESULT" 2>/dev/null || exit 0
