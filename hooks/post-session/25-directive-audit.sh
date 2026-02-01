#!/bin/bash
# Post-session: audit which directives were followed/ignored using Sonnet.
# Updates directive-tracking.json v3 schema (canonical IDs only).
#
# s349: Rewritten with canonical directive list to prevent name divergence.
# s366: Added error logging — failures were silently swallowed, causing stale tracking.
# s418: Added per-directive history array (last 10 evaluations) for trend analysis.
# s419: Renamed backlog-consumption→queue-consumption (backlog.md retired s403).
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
# s411: Removed 3 infrastructure-enforced directives (startup-files, security-audit, infrastructure-audit).
# s415: Removed 2 structurally unfollowable directives:
# - moltbook-writes: platform broken for 80+ sessions (2 followed / 12 ignored). Not agent-behavioral.
# - no-heavy-coding: too vague for Haiku to evaluate reliably (5 followed / 8 ignored).
CANONICAL_DIRECTIVES='[
  {"id": "structural-change", "modes": ["R"], "desc": "R sessions: make at least one structural code change"},
  {"id": "commit-and-push", "modes": ["B", "R"], "desc": "Commit and push changes to git"},
  {"id": "reflection-summary", "modes": ["R"], "desc": "R sessions: write honest reflection summary"},
  {"id": "platform-engagement", "modes": ["E"], "desc": "E sessions: engage on platforms (Chatr, 4claw, Moltbook)"},
  {"id": "platform-discovery", "modes": ["E"], "desc": "Discover or try new agent platforms"},
  {"id": "queue-consumption", "modes": ["B"], "desc": "B sessions: complete assigned item from work-queue.json"},
  {"id": "ecosystem-adoption", "modes": ["B", "E", "R"], "desc": "Use services other agents built"},
  {"id": "briefing-update", "modes": ["R"], "desc": "R sessions: keep BRIEFING.md accurate"},
  {"id": "directive-update", "modes": ["R"], "desc": "R sessions: update directive tracking"}
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
    'reflection-summary': ['R'],
    'platform-engagement': ['E'],
    'platform-discovery': ['E'], 'queue-consumption': ['B'],
    'ecosystem-adoption': ['B', 'E', 'R'], 'briefing-update': ['R'],
    'directive-update': ['R']
}
CANONICAL = set(DIRECTIVE_MODES.keys())

try:
    raw_tracking = open('$TRACKING_FILE').read().strip()
    if not raw_tracking:
        raise ValueError('empty file')
    data = json.loads(raw_tracking)
except Exception as e:
    print(f'WARN: tracking file reset: {e}', file=sys.stderr)
    data = {'version': 7, 'directives': {}}

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

# Append history entries for applicable directives (max 10 per directive)
followed_set = set(n.lower().strip() for n in audit.get('followed', []))
ignored_set = set()
for item in audit.get('ignored', []):
    if isinstance(item, str):
        ignored_set.add(item.lower().strip())
    else:
        ignored_set.add(item.get('id', item.get('name', '')).lower().strip())

for did, modes in DIRECTIVE_MODES.items():
    if mode not in modes:
        continue
    d = data['directives'].get(did, {})
    if 'history' not in d:
        d['history'] = []
    result = 'followed' if did in followed_set else ('ignored' if did in ignored_set else 'followed')
    d['history'].append({'session': session, 'result': result})
    d['history'] = d['history'][-10:]  # keep last 10

json.dump(data, open('$TRACKING_FILE', 'w'), indent=2)
applicable_count = sum(1 for d, m in DIRECTIVE_MODES.items() if mode in m)
print(f'Updated {len(audit.get(\"followed\",[]))} followed, {len(audit.get(\"ignored\",[]))} ignored, {applicable_count} applicable for mode {mode}')
" <<< "$RAW_RESULT" 2>&1) || {
  log "ERROR: python update failed: ${UPDATE_OUTPUT:0:200} | raw: ${RAW_RESULT:0:200}"
  exit 0
}

log "OK: $UPDATE_OUTPUT"
