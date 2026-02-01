#!/bin/bash
# Post-session: audit which directives were followed/ignored using Sonnet.
# Updates directive-tracking.json v3 schema (canonical IDs only).
#
# s349: Rewritten with canonical directive list to prevent name divergence.
# s366: Added error logging — failures were silently swallowed, causing stale tracking.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TRACKING_FILE="$DIR/directive-tracking.json"
AUDIT_LOG="$HOME/.config/moltbook/logs/directive-audit.log"

log() { echo "$(date -Iseconds) s=${SESSION_NUM:-?} $*" >> "$AUDIT_LOG"; }

if [ -z "${LOG_FILE:-}" ]; then log "SKIP: no LOG_FILE"; exit 0; fi
if [ -z "${MODE_CHAR:-}" ]; then log "SKIP: no MODE_CHAR"; exit 0; fi
if [ ! -f "$LOG_FILE" ]; then log "SKIP: LOG_FILE not found: $LOG_FILE"; exit 0; fi

case "$MODE_CHAR" in
  R) SESSION_FILE="$DIR/SESSION_REFLECT.md" ;;
  B) SESSION_FILE="$DIR/SESSION_BUILD.md" ;;
  E) SESSION_FILE="$DIR/SESSION_ENGAGE.md" ;;
  *) SESSION_FILE="$DIR/SESSION_ENGAGE.md" ;;
esac
if [ ! -f "$SESSION_FILE" ]; then log "SKIP: SESSION_FILE not found: $SESSION_FILE"; exit 0; fi

SESSION_CONTENT=$(head -80 "$SESSION_FILE")

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
print('\n'.join(texts[-20:]))
" 2>&1) || { log "ERROR: log extraction failed: $LOG_SUMMARY"; exit 0; }

if [ -z "$LOG_SUMMARY" ]; then log "SKIP: empty log summary from $LOG_FILE"; exit 0; fi

# Canonical directive list with applicable session modes.
# "modes" field tells the updater which session types each directive applies to.
CANONICAL_DIRECTIVES='[
  {"id": "structural-change", "modes": ["R"], "desc": "R sessions: make at least one structural code change"},
  {"id": "commit-and-push", "modes": ["B", "R"], "desc": "Commit and push changes to git"},
  {"id": "reflection-summary", "modes": ["R"], "desc": "R sessions: write honest reflection summary"},
  {"id": "startup-files", "modes": ["B", "E", "R"], "desc": "Read the correct startup files for session type"},
  {"id": "platform-engagement", "modes": ["E"], "desc": "E sessions: engage on platforms (Chatr, 4claw, Moltbook)"},
  {"id": "moltbook-writes", "modes": ["E"], "desc": "Comment or vote on Moltbook posts"},
  {"id": "platform-discovery", "modes": ["E"], "desc": "Discover or try new agent platforms"},
  {"id": "backlog-consumption", "modes": ["B"], "desc": "B sessions: pick work from work-queue.json"},
  {"id": "ecosystem-adoption", "modes": ["B", "E", "R"], "desc": "Use services other agents built"},
  {"id": "security-audit", "modes": ["R"], "desc": "R maintain: check secrets, permissions, ports"},
  {"id": "infrastructure-audit", "modes": ["R"], "desc": "R maintain: check disk, logs, services"},
  {"id": "briefing-update", "modes": ["R"], "desc": "R sessions: keep BRIEFING.md accurate"},
  {"id": "directive-update", "modes": ["R"], "desc": "R sessions: update directive tracking"},
  {"id": "no-heavy-coding", "modes": ["E"], "desc": "E sessions: focus on engagement, not building"}
]'

APPLICABLE_DIRECTIVES=$(echo "$CANONICAL_DIRECTIVES" | python3 -c "
import json, sys
directives = json.load(sys.stdin)
mode = '${MODE_CHAR:-}'
applicable = [d for d in directives if mode in d['modes']]
print(json.dumps(applicable, indent=2))
")

PROMPT="Audit this agent session (mode=$MODE_CHAR). Return ONLY a JSON object, no prose.

Format: {\"followed\":[\"id\",...],\"ignored\":[{\"id\":\"id\",\"reason\":\"why\"},...]}

Use ONLY these directive IDs:
$APPLICABLE_DIRECTIVES

Agent activity:
$LOG_SUMMARY"

RAW_RESULT=$(echo "$PROMPT" | claude -p --model haiku --max-budget-usd 0.02 --output-format text 2>&1) || {
  log "ERROR: claude call failed: ${RAW_RESULT:0:200}"
  exit 0
}

if [ -z "$RAW_RESULT" ]; then log "ERROR: claude returned empty result"; exit 0; fi
if echo "$RAW_RESULT" | grep -qi "exceeded.*budget"; then log "ERROR: claude budget exceeded: ${RAW_RESULT:0:200}"; exit 0; fi

UPDATE_OUTPUT=$(python3 -c "
import json, sys, re

raw = sys.stdin.read().strip()
# Try to extract JSON object from anywhere in the response
raw = re.sub(r'^\`\`\`(?:json)?\s*', '', raw)
raw = re.sub(r'\s*\`\`\`\s*$', '', raw)
# Find first { ... } block
m = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', raw, re.DOTALL)
if m:
    raw = m.group(0)
audit = json.loads(raw.strip())

# Directive metadata: which session modes each applies to
DIRECTIVE_MODES = {
    'structural-change': ['R'], 'commit-and-push': ['B', 'R'],
    'reflection-summary': ['R'], 'startup-files': ['B', 'E', 'R'],
    'platform-engagement': ['E'], 'moltbook-writes': ['E'],
    'platform-discovery': ['E'], 'backlog-consumption': ['B'],
    'ecosystem-adoption': ['B', 'E', 'R'], 'security-audit': ['R'],
    'infrastructure-audit': ['R'], 'briefing-update': ['R'],
    'directive-update': ['R'], 'no-heavy-coding': ['E']
}
CANONICAL = set(DIRECTIVE_MODES.keys())

try:
    data = json.load(open('$TRACKING_FILE'))
except:
    data = {'version': 4, 'directives': {}}

# Migrate to v4: add last_applicable_session field
if data.get('version', 0) < 4:
    data['version'] = 4
    data['description'] = 'Per-directive compliance counters with applicability tracking'
    for k, v in data.get('directives', {}).items():
        if isinstance(v, dict) and 'last_applicable_session' not in v:
            v['last_applicable_session'] = v.get('last_session', 0)

session = ${SESSION_NUM:-0}
mode = '${MODE_CHAR:-}'

# Mark all applicable directives for this session type
for did, modes in DIRECTIVE_MODES.items():
    if mode in modes:
        if did not in data['directives']:
            data['directives'][did] = {'followed': 0, 'ignored': 0, 'last_ignored_reason': None, 'last_session': 0, 'last_applicable_session': 0}
        data['directives'][did]['last_applicable_session'] = session

for name in audit.get('followed', []):
    key = name.lower().strip()
    if key not in CANONICAL:
        continue
    # Guard: only count followed if directive applies to current session type
    if mode not in DIRECTIVE_MODES.get(key, []):
        continue
    if key not in data['directives']:
        data['directives'][key] = {'followed': 0, 'ignored': 0, 'last_ignored_reason': None, 'last_session': 0, 'last_applicable_session': 0}
    data['directives'][key]['followed'] += 1
    data['directives'][key]['last_session'] = session

for item in audit.get('ignored', []):
    if isinstance(item, str):
        key, reason = item.lower().strip(), 'unknown'
    else:
        key, reason = item.get('id', item.get('name', '')).lower().strip(), item.get('reason', 'unknown')
    if key not in CANONICAL:
        continue
    # Guard: only count ignored if directive applies to current session type
    if mode not in DIRECTIVE_MODES.get(key, []):
        continue
    if key not in data['directives']:
        data['directives'][key] = {'followed': 0, 'ignored': 0, 'last_ignored_reason': None, 'last_session': 0, 'last_applicable_session': 0}
    data['directives'][key]['ignored'] += 1
    data['directives'][key]['last_ignored_reason'] = reason
    data['directives'][key]['last_session'] = session

json.dump(data, open('$TRACKING_FILE', 'w'), indent=2)
applicable_count = sum(1 for d, m in DIRECTIVE_MODES.items() if mode in m)
print(f'Updated {len(audit.get(\"followed\",[]))} followed, {len(audit.get(\"ignored\",[]))} ignored, {applicable_count} applicable for mode {mode}')
" <<< "$RAW_RESULT" 2>&1) || {
  log "ERROR: python update failed: ${UPDATE_OUTPUT:0:200} | raw: ${RAW_RESULT:0:200}"
  exit 0
}

log "OK: $UPDATE_OUTPUT"
