#!/usr/bin/env python3
"""Extract decisions, blockers, and completed tasks from a session log (JSONL).
Usage: session-debrief.py <log_file> <session_num> <mode> [focus]
Appends structured debrief to ~/.config/moltbook/session-debriefs.json
"""
import json, re, sys, os
from datetime import datetime
from pathlib import Path

DEBRIEF_FILE = Path.home() / ".config/moltbook/session-debriefs.json"

def extract_texts(log_path):
    """Pull assistant text and error signals from JSONL log."""
    texts = []
    with open(log_path, 'r', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            role = obj.get('role', '')
            content = obj.get('content', '')
            if role == 'assistant':
                if isinstance(content, str):
                    texts.append(content[:2000])
                elif isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get('type') == 'text':
                            texts.append(block.get('text', '')[:2000])
            elif role == 'tool' and isinstance(content, str):
                low = content.lower()
                if any(w in low for w in ('error', 'blocked', 'failed', 'denied', 'timeout')):
                    texts.append(f'[TOOL_ERR] {content[:500]}')
    return texts

def analyze(texts):
    decisions, blockers, tasks_done = [], [], []
    for t in texts:
        low = t.lower()
        for pat in [r'(?:decided|choosing|going with|will use|switching to|picked) .{10,80}',
                    r'(?:the approach|solution|plan) (?:is|will be) .{10,80}']:
            for m in re.finditer(pat, low):
                decisions.append(m.group(0)[:120])
        for pat in [r'(?:blocked|cannot|unable to|failed because|broken) .{10,80}',
                    r'(?:waiting on|depends on|need.{0,10}before) .{10,80}']:
            for m in re.finditer(pat, low):
                blockers.append(m.group(0)[:120])
        for pat in [r'(?:completed|shipped|done|committed).{0,80}']:
            for m in re.finditer(pat, low):
                tasks_done.append(m.group(0)[:120])
    return {
        'decisions': list(dict.fromkeys(decisions))[:10],
        'blockers': list(dict.fromkeys(blockers))[:10],
        'tasks_completed': list(dict.fromkeys(tasks_done))[:10],
    }

def main():
    if len(sys.argv) < 3:
        print("Usage: session-debrief.py <log_file> <session_num> <mode> [focus]", file=sys.stderr)
        sys.exit(1)

    log_file = sys.argv[1]
    session_num = int(sys.argv[2])
    mode = sys.argv[3] if len(sys.argv) > 3 else '?'
    focus = sys.argv[4] if len(sys.argv) > 4 else None

    if not os.path.isfile(log_file):
        print(f"Log file not found: {log_file}", file=sys.stderr)
        sys.exit(1)

    texts = extract_texts(log_file)
    result = analyze(texts)

    entry = {
        'timestamp': datetime.now().isoformat(),
        'session': session_num,
        'mode': mode,
        'focus': focus,
        **result,
    }

    DEBRIEF_FILE.parent.mkdir(parents=True, exist_ok=True)
    try:
        data = json.loads(DEBRIEF_FILE.read_text())
    except:
        data = []

    data.append(entry)
    data = data[-100:]
    DEBRIEF_FILE.write_text(json.dumps(data, indent=2))

    print(f"Debrief s{session_num}: {len(result['decisions'])} decisions, {len(result['blockers'])} blockers, {len(result['tasks_completed'])} tasks")

if __name__ == '__main__':
    main()
