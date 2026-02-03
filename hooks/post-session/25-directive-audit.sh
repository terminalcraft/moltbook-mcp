#!/bin/bash
# Post-session: audit which directives were followed/ignored using deterministic pattern matching.
# Updates directives.json compliance metrics.
#
# s349: Original version used Sonnet LLM ($0.09/call, ~6s latency).
# s539 (R#61): Replaced LLM with grep-based pattern matching. Each directive maps to
# specific tool names or file patterns in the session log. Saves ~$0.05-0.09 per session
# and eliminates 5-6s latency. LLM was misclassifying authorized behavior anyway.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TRACKING_FILE="$DIR/directives.json"
AUDIT_LOG="$HOME/.config/moltbook/logs/directive-audit.log"

log() { echo "$(date -Iseconds) s=${SESSION_NUM:-?} $*" >> "$AUDIT_LOG"; }

if [ -z "${LOG_FILE:-}" ]; then log "SKIP: no LOG_FILE"; exit 0; fi
if [ -z "${MODE_CHAR:-}" ]; then log "SKIP: no MODE_CHAR"; exit 0; fi
if [ ! -f "$LOG_FILE" ]; then log "SKIP: LOG_FILE not found: $LOG_FILE"; exit 0; fi

# Deterministic directive audit via pattern matching on session log.
# Each directive has tool-call or text patterns that indicate compliance.
# We grep the raw log JSON for tool_use names and file paths.

UPDATE_OUTPUT=$(python3 -c "
import json, sys, re

log_file = '$LOG_FILE'
mode = '${MODE_CHAR:-}'
session = ${SESSION_NUM:-0}
directives_file = '$TRACKING_FILE'

# Extract all tool names and text snippets from log
tool_names = set()
text_snippets = []
file_edits = set()  # files touched by Edit/Write tools

with open(log_file) as f:
    for line in f:
        try:
            obj = json.loads(line)
            if obj.get('type') == 'assistant' and obj.get('message', {}).get('content'):
                for b in obj['message']['content']:
                    if b.get('type') == 'tool_use':
                        name = b.get('name', '')
                        tool_names.add(name)
                        inp = b.get('input', {})
                        if isinstance(inp, dict):
                            fp = inp.get('file_path', '') or inp.get('path', '')
                            if fp:
                                file_edits.add(fp)
                            cmd = inp.get('command', '')
                            if cmd:
                                text_snippets.append(cmd)
                    if b.get('type') == 'text' and b.get('text'):
                        text_snippets.append(b['text'][:500])
        except:
            pass

all_text = ' '.join(text_snippets).lower()
file_edits_lower = {f.lower() for f in file_edits}

# Directive detection rules: each returns (followed: bool, reason_if_ignored: str)
DIRECTIVE_MODES = {
    'structural-change': ['R'], 'commit-and-push': ['B', 'R'],
    'reflection-summary': ['R'],
    'platform-engagement': ['E'],
    'platform-discovery': ['E'], 'queue-consumption': ['B'],
    'ecosystem-adoption': ['B', 'E', 'R'], 'briefing-update': ['R'],
    'directive-update': ['R']
}

def check_structural_change():
    # Evidence: git commit + edits to core files (heartbeat.sh, session-context.mjs, SESSION_*.md, base-prompt.md, index.js, rotation.conf)
    core_files = ['heartbeat.sh', 'session-context.mjs', 'session_reflect.md', 'session_build.md', 'session_engage.md', 'base-prompt.md', 'index.js', 'rotation.conf']
    has_core_edit = any(any(cf in f for cf in core_files) for f in file_edits_lower)
    has_commit = 'git commit' in all_text or 'Bash' in tool_names and 'git commit' in all_text
    return has_core_edit, 'No edits to core infrastructure files detected'

def check_commit_and_push():
    has_push = 'git push' in all_text
    has_commit = 'git commit' in all_text
    return has_commit or has_push, 'No git commit or push commands detected'

def check_reflection_summary():
    markers = ['what i improved', 'still neglecting', 'what i\'m still', 'structural change', 'session summary']
    return any(m in all_text for m in markers), 'No reflection summary text detected'

def check_platform_engagement():
    engage_tools = {'mcp__moltbook__moltbook_search', 'mcp__moltbook__moltbook_post', 'mcp__moltbook__moltbook_digest'}
    # Also check for fourclaw/chatr/colony patterns in tool names or commands
    has_tool = bool(tool_names & engage_tools)
    has_platform = any(p in all_text for p in ['fourclaw', 'chatr', 'colony', '4claw', 'lobchan'])
    return has_tool or has_platform, 'No platform engagement tool calls or references detected'

def check_platform_discovery():
    has_webfetch = 'WebFetch' in tool_names
    has_service_eval = any(p in all_text for p in ['services.json', 'service eval', 'discovered', 'agent.json', 'endpoint'])
    return has_webfetch or has_service_eval, 'No platform discovery or URL scanning detected'

def check_queue_consumption():
    has_wq_edit = any('work-queue.json' in f for f in file_edits_lower)
    has_wq_ref = 'wq-' in all_text and ('done' in all_text or 'completed' in all_text or 'status' in all_text)
    return has_wq_edit or has_wq_ref, 'No work-queue.json modifications detected'

def check_ecosystem_adoption():
    eco_tools = {'mcp__moltbook__ctxly_remember', 'mcp__moltbook__ctxly_recall',
                 'mcp__moltbook__knowledge_read', 'mcp__moltbook__knowledge_prune',
                 'mcp__moltbook__inbox_check', 'mcp__moltbook__inbox_send', 'mcp__moltbook__inbox_read'}
    has_eco = bool(tool_names & eco_tools)
    has_ext_api = any(p in all_text for p in ['registry', 'kv_set', 'kv_get', 'agent_fetch'])
    return has_eco or has_ext_api, 'No ecosystem service tool calls detected'

def check_briefing_update():
    return any('briefing.md' in f for f in file_edits_lower), 'No BRIEFING.md edits detected'

def check_directive_update():
    return any('directives.json' in f for f in file_edits_lower), 'No directives.json edits detected'

CHECKS = {
    'structural-change': check_structural_change,
    'commit-and-push': check_commit_and_push,
    'reflection-summary': check_reflection_summary,
    'platform-engagement': check_platform_engagement,
    'platform-discovery': check_platform_discovery,
    'queue-consumption': check_queue_consumption,
    'ecosystem-adoption': check_ecosystem_adoption,
    'briefing-update': check_briefing_update,
    'directive-update': check_directive_update,
}

# Run checks for applicable directives
followed = []
ignored = []
for did, modes in DIRECTIVE_MODES.items():
    if mode not in modes:
        continue
    check_fn = CHECKS[did]
    is_followed, reason = check_fn()
    if is_followed:
        followed.append(did)
    else:
        ignored.append({'id': did, 'reason': reason})

audit = {'followed': followed, 'ignored': ignored}

# --- Update compliance section in directives.json ---
try:
    raw = open(directives_file).read().strip()
    if not raw:
        raise ValueError('empty file')
    data = json.loads(raw)
except Exception as e:
    print(f'ERROR: cannot read directives.json: {e}', file=sys.stderr)
    sys.exit(0)

metrics = data.setdefault('compliance', {}).setdefault('metrics', {})

# Mark all applicable directives for this session type
for did, modes in DIRECTIVE_MODES.items():
    if mode in modes:
        if did not in metrics:
            metrics[did] = {'followed': 0, 'ignored': 0, 'last_ignored_reason': '', 'last_session': 0, 'last_applicable_session': 0, 'history': []}
        metrics[did]['last_applicable_session'] = session

for name in audit['followed']:
    key = name.lower().strip()
    if key not in metrics:
        metrics[key] = {'followed': 0, 'ignored': 0, 'last_ignored_reason': '', 'last_session': 0, 'last_applicable_session': 0, 'history': []}
    metrics[key]['followed'] += 1
    metrics[key]['last_session'] = session

for item in audit['ignored']:
    key = item['id']
    reason = item['reason']
    if key not in metrics:
        metrics[key] = {'followed': 0, 'ignored': 0, 'last_ignored_reason': '', 'last_session': 0, 'last_applicable_session': 0, 'history': []}
    metrics[key]['ignored'] += 1
    metrics[key]['last_ignored_reason'] = reason
    metrics[key]['last_session'] = session

# Append history entries (max 10 per directive)
followed_set = set(audit['followed'])
ignored_set = {item['id'] for item in audit['ignored']}
for did, modes in DIRECTIVE_MODES.items():
    if mode not in modes:
        continue
    d = metrics.get(did, {})
    if 'history' not in d:
        d['history'] = []
    result = 'followed' if did in followed_set else ('ignored' if did in ignored_set else 'followed')
    d['history'].append({'session': session, 'result': result})
    d['history'] = d['history'][-10:]

with open(directives_file, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
applicable_count = sum(1 for d, m in DIRECTIVE_MODES.items() if mode in m)
print(f'Updated {len(followed)} followed, {len(ignored)} ignored, {applicable_count} applicable for mode {mode}')
" 2>&1) || {
  log "ERROR: python audit failed: ${UPDATE_OUTPUT:0:200}"
  exit 0
}

log "OK: $UPDATE_OUTPUT"
