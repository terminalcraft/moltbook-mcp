#!/bin/bash
# Post-session: audit which directives were followed/ignored using Sonnet.
# Updates directive-tracking.json v3 schema (canonical IDs only).
#
# s349: Rewritten with canonical directive list to prevent name divergence.
# Previously Sonnet created free-text names, causing 35+ entries with duplicates
# like "try new platform" vs "new platform exploration" vs "check discover_list".
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TRACKING_FILE="$DIR/directive-tracking.json"

[ -z "${LOG_FILE:-}" ] && exit 0
[ -z "${MODE_CHAR:-}" ] && exit 0
[ -f "$LOG_FILE" ] || exit 0

case "$MODE_CHAR" in
  R) SESSION_FILE="$DIR/SESSION_REFLECT.md" ;;
  B) SESSION_FILE="$DIR/SESSION_BUILD.md" ;;
  E) SESSION_FILE="$DIR/SESSION_ENGAGE.md" ;;
  *) SESSION_FILE="$DIR/SESSION_ENGAGE.md" ;;
esac
[ -f "$SESSION_FILE" ] || exit 0

SESSION_CONTENT=$(cat "$SESSION_FILE")

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

# Canonical directive list — Sonnet MUST map to these exact IDs.
# This prevents name divergence (the old approach created 35+ free-text entries).
CANONICAL_DIRECTIVES='[
  {"id": "structural-change", "desc": "R sessions: make at least one structural code change"},
  {"id": "commit-and-push", "desc": "Commit and push changes to git"},
  {"id": "reflection-summary", "desc": "R sessions: write honest reflection summary"},
  {"id": "startup-files", "desc": "Read the correct startup files for session type"},
  {"id": "platform-engagement", "desc": "E sessions: engage on platforms (Chatr, 4claw, Moltbook)"},
  {"id": "moltbook-writes", "desc": "Comment or vote on Moltbook posts"},
  {"id": "platform-discovery", "desc": "Discover or try new agent platforms"},
  {"id": "backlog-consumption", "desc": "B sessions: pick work from backlog/queue"},
  {"id": "ecosystem-adoption", "desc": "Use services other agents built"},
  {"id": "security-audit", "desc": "R maintain: check secrets, permissions, ports"},
  {"id": "infrastructure-audit", "desc": "R maintain: check disk, logs, services"},
  {"id": "briefing-update", "desc": "R sessions: keep BRIEFING.md accurate"},
  {"id": "directive-update", "desc": "R sessions: update directive tracking"},
  {"id": "no-heavy-coding", "desc": "E sessions: focus on engagement, not building"}
]'

PROMPT="You are auditing an autonomous agent session. Below are the SESSION DIRECTIVES, the CANONICAL DIRECTIVE IDS, and a SUMMARY OF WHAT THE AGENT DID.

IMPORTANT: You MUST map to CANONICAL IDs only. Do NOT invent new names. If a directive does not match any canonical ID, skip it.

Return ONLY valid JSON:
{\"followed\":[\"canonical-id\",...],\"ignored\":[{\"id\":\"canonical-id\",\"reason\":\"short reason\"},...]}

CANONICAL DIRECTIVE IDS:
$CANONICAL_DIRECTIVES

SESSION DIRECTIVES:
$SESSION_CONTENT

AGENT ACTIVITY:
$LOG_SUMMARY"

RAW_RESULT=$(claude -p "$PROMPT" --model claude-sonnet-4-20250514 --max-budget-usd 0.03 --output-format text 2>/dev/null) || exit 0

python3 -c "
import json, sys, re

raw = sys.stdin.read().strip()
raw = re.sub(r'^\`\`\`(?:json)?\s*', '', raw)
raw = re.sub(r'\s*\`\`\`\s*$', '', raw)
audit = json.loads(raw.strip())

CANONICAL = {
    'structural-change', 'commit-and-push', 'reflection-summary',
    'startup-files', 'platform-engagement', 'moltbook-writes',
    'platform-discovery', 'backlog-consumption', 'ecosystem-adoption',
    'security-audit', 'infrastructure-audit', 'briefing-update',
    'directive-update', 'no-heavy-coding'
}

try:
    data = json.load(open('$TRACKING_FILE'))
except:
    data = {'version': 3, 'description': 'Per-directive compliance counters (canonical IDs only)', 'directives': {}}

# Migrate v2 -> v3: drop old free-text entries, keep canonical matches
if data.get('version', 0) < 3:
    old = data.get('directives', {})
    data = {'version': 3, 'description': 'Per-directive compliance counters (canonical IDs only)', 'directives': {}}
    for k, v in old.items():
        if k in CANONICAL:
            data['directives'][k] = v

session = ${SESSION_NUM:-0}

for name in audit.get('followed', []):
    key = name.lower().strip()
    if key not in CANONICAL:
        continue
    if key not in data['directives']:
        data['directives'][key] = {'followed': 0, 'ignored': 0, 'last_ignored_reason': None, 'last_session': 0}
    data['directives'][key]['followed'] += 1
    data['directives'][key]['last_session'] = session

for item in audit.get('ignored', []):
    if isinstance(item, str):
        key, reason = item.lower().strip(), 'unknown'
    else:
        key, reason = item.get('id', item.get('name', '')).lower().strip(), item.get('reason', 'unknown')
    if key not in CANONICAL:
        continue
    if key not in data['directives']:
        data['directives'][key] = {'followed': 0, 'ignored': 0, 'last_ignored_reason': None, 'last_session': 0}
    data['directives'][key]['ignored'] += 1
    data['directives'][key]['last_ignored_reason'] = reason
    data['directives'][key]['last_session'] = session

json.dump(data, open('$TRACKING_FILE', 'w'), indent=2)
print(f'Updated {len(audit.get(\"followed\",[]))} followed, {len(audit.get(\"ignored\",[]))} ignored')
" <<< "$RAW_RESULT" 2>/dev/null || exit 0
