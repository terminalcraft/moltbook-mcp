#!/usr/bin/env python3
"""Directive compliance audit — deterministic pattern matching on session logs.

Extracted from 25-directive-audit.sh (R#306). Previously ran as inline Python
in a bash heredoc. Now a standalone module that can be independently tested.

Usage: python3 directive-audit.py <log_file> <mode_char> <session_num> <directives_file>

Exit codes:
  0 — success (prints "Updated N followed, M ignored, K applicable for mode X")
  1 — argument error
  2 — directives.json read/parse error
"""

import json
import sys
import os


def extract_session_data(log_file):
    """Extract tool names, text snippets, and file edits from a session log."""
    tool_names = set()
    text_snippets = []
    file_edits = set()

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
            except Exception:
                pass

    all_text = ' '.join(text_snippets).lower()
    file_edits_lower = {f.lower() for f in file_edits}
    return tool_names, all_text, file_edits_lower


# Directive mode applicability map
DIRECTIVE_MODES = {
    'structural-change': ['R'],
    'commit-and-push': ['B', 'R'],
    'reflection-summary': ['R'],
    'platform-engagement': ['E'],
    'platform-discovery': ['E'],
    'queue-consumption': ['B'],
    'ecosystem-adoption': ['B', 'E', 'R'],
    'briefing-update': ['R'],
    'directive-update': ['R'],
}


def check_structural_change(tool_names, all_text, file_edits_lower):
    core_exact = ['heartbeat.sh', 'session-context.mjs', 'base-prompt.md', 'index.js', 'rotation.conf']
    core_patterns = ['session_', 'hooks/']
    has_exact = any(any(cf in f for cf in core_exact) for f in file_edits_lower)
    has_pattern = any(any(cp in f for cp in core_patterns) for f in file_edits_lower)
    return has_exact or has_pattern, 'No edits to core infrastructure files detected'


def check_commit_and_push(tool_names, all_text, file_edits_lower):
    has_push = 'git push' in all_text
    has_commit = 'git commit' in all_text
    return has_commit or has_push, 'No git commit or push commands detected'


def check_reflection_summary(tool_names, all_text, file_edits_lower):
    markers = ['what i improved', 'still neglecting', "what i'm still", 'structural change', 'session summary']
    return any(m in all_text for m in markers), 'No reflection summary text detected'


def check_platform_engagement(tool_names, all_text, file_edits_lower):
    engage_tools = {'mcp__moltbook__moltbook_search', 'mcp__moltbook__moltbook_post', 'mcp__moltbook__moltbook_digest'}
    has_tool = bool(tool_names & engage_tools)
    has_platform = any(p in all_text for p in ['fourclaw', 'chatr', 'colony', '4claw', 'lobchan'])
    return has_tool or has_platform, 'No platform engagement tool calls or references detected'


def check_platform_discovery(tool_names, all_text, file_edits_lower):
    has_webfetch = 'WebFetch' in tool_names
    has_service_eval = any(p in all_text for p in ['services.json', 'service eval', 'discovered', 'agent.json', 'endpoint'])
    return has_webfetch or has_service_eval, 'No platform discovery or URL scanning detected'


def check_queue_consumption(tool_names, all_text, file_edits_lower):
    has_wq_edit = any('work-queue.json' in f for f in file_edits_lower)
    has_wq_ref = 'wq-' in all_text and ('done' in all_text or 'completed' in all_text or 'status' in all_text)
    return has_wq_edit or has_wq_ref, 'No work-queue.json modifications detected'


def check_ecosystem_adoption(tool_names, all_text, file_edits_lower):
    eco_tools = {
        'mcp__moltbook__ctxly_remember', 'mcp__moltbook__ctxly_recall',
        'mcp__moltbook__knowledge_read', 'mcp__moltbook__knowledge_prune',
        'mcp__moltbook__inbox_check', 'mcp__moltbook__inbox_send', 'mcp__moltbook__inbox_read',
    }
    has_eco = bool(tool_names & eco_tools)
    has_ext_api = any(p in all_text for p in ['registry', 'kv_set', 'kv_get', 'agent_fetch'])
    return has_eco or has_ext_api, 'No ecosystem service tool calls detected'


def check_briefing_update(tool_names, all_text, file_edits_lower):
    return any('briefing.md' in f for f in file_edits_lower), 'No BRIEFING.md edits detected'


def check_directive_update(tool_names, all_text, file_edits_lower):
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


def run_audit(log_file, mode, session, directives_file):
    """Run directive compliance audit and update directives.json."""
    tool_names, all_text, file_edits_lower = extract_session_data(log_file)

    # Run checks for applicable directives
    followed = []
    ignored = []
    for did, modes in DIRECTIVE_MODES.items():
        if mode not in modes:
            continue
        check_fn = CHECKS[did]
        is_followed, reason = check_fn(tool_names, all_text, file_edits_lower)
        if is_followed:
            followed.append(did)
        else:
            ignored.append({'id': did, 'reason': reason})

    # --- Update compliance section in directives.json ---
    try:
        raw = open(directives_file).read().strip()
        if not raw:
            raise ValueError('empty file')
        data = json.loads(raw)
    except Exception as e:
        print(f'ERROR: cannot read directives.json: {e}', file=sys.stderr)
        sys.exit(2)

    metrics = data.setdefault('compliance', {}).setdefault('metrics', {})

    # Mark all applicable directives for this session type
    for did, modes in DIRECTIVE_MODES.items():
        if mode in modes:
            if did not in metrics:
                metrics[did] = {
                    'followed': 0, 'ignored': 0, 'last_ignored_reason': '',
                    'last_session': 0, 'last_applicable_session': 0, 'history': [],
                }
            metrics[did]['last_applicable_session'] = session

    for name in followed:
        key = name.lower().strip()
        if key not in metrics:
            metrics[key] = {
                'followed': 0, 'ignored': 0, 'last_ignored_reason': '',
                'last_session': 0, 'last_applicable_session': 0, 'history': [],
            }
        metrics[key]['followed'] += 1
        metrics[key]['last_session'] = session

    for item in ignored:
        key = item['id']
        reason = item['reason']
        if key not in metrics:
            metrics[key] = {
                'followed': 0, 'ignored': 0, 'last_ignored_reason': '',
                'last_session': 0, 'last_applicable_session': 0, 'history': [],
            }
        metrics[key]['ignored'] += 1
        metrics[key]['last_ignored_reason'] = reason
        metrics[key]['last_session'] = session

    # Append history entries (max 10 per directive)
    followed_set = set(followed)
    ignored_set = {item['id'] for item in ignored}
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


def main():
    if len(sys.argv) != 5:
        print(f'Usage: {sys.argv[0]} <log_file> <mode_char> <session_num> <directives_file>', file=sys.stderr)
        sys.exit(1)

    log_file = sys.argv[1]
    mode = sys.argv[2]
    session = int(sys.argv[3])
    directives_file = sys.argv[4]

    if not os.path.isfile(log_file):
        print(f'ERROR: log file not found: {log_file}', file=sys.stderr)
        sys.exit(1)

    run_audit(log_file, mode, session, directives_file)


if __name__ == '__main__':
    main()
