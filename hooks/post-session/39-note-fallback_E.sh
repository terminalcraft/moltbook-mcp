#!/bin/bash
# 39-note-fallback_E.sh — Fix truncated E session notes in session-history.txt
#
# Problem (wq-451, a108-1 recurring):
# E sessions often hit budget/time limits before reaching Phase 4, where the
# completion line is output. The 10-summarize.sh hook then falls back to
# garbage text like "Now entering Phase 2..." or "Here's my situation:".
#
# Solution: After 10-summarize.sh writes the history line, this hook checks
# if the note looks truncated. If so, it regenerates from engagement-trace.json
# which is written during Phase 2 (before truncation can occur).
#
# Created: B#369 (wq-451)
set -euo pipefail

STATE_DIR="$HOME/.config/moltbook"
HISTORY_FILE="$STATE_DIR/session-history.txt"
TRACE_FILE="$STATE_DIR/engagement-trace.json"

: "${SESSION_NUM:?SESSION_NUM required}"
: "${MODE_CHAR:?MODE_CHAR required}"

[ -f "$HISTORY_FILE" ] || exit 0
[ -f "$TRACE_FILE" ] || exit 0

# Find the history line for this session
HISTORY_LINE=$(grep "s=$SESSION_NUM " "$HISTORY_FILE" | tail -1)
[ -n "$HISTORY_LINE" ] || exit 0

# Extract the current note
CURRENT_NOTE=$(echo "$HISTORY_LINE" | sed -n 's/.*note: //p')

# Check if the note looks like a proper completion line
# Good notes match: "Session E#NNN (sNNN) complete."
if echo "$CURRENT_NOTE" | grep -qiE '^Session [A-Z]#[0-9]+.*complete'; then
  exit 0  # Note is fine, nothing to fix
fi

# Also accept notes that are clearly substantive (>60 chars with platform mentions)
if [ "${#CURRENT_NOTE}" -gt 60 ] && echo "$CURRENT_NOTE" | grep -qiE 'engag|platform|chatr|moltbook|4claw|aicq|clawball|lobchan|pinchwork|colony'; then
  exit 0  # Note is substantive enough
fi

# Note is truncated or garbage — generate from engagement-trace.json
GENERATED_NOTE=$(python3 -c "
import json, sys

trace_file = '$TRACE_FILE'
session = int('$SESSION_NUM')

try:
    with open(trace_file) as f:
        traces = json.load(f)
    if not isinstance(traces, list):
        traces = [traces] if isinstance(traces, dict) else []
except:
    sys.exit(1)

# Find trace entry for this session
entry = None
for t in reversed(traces):
    if t.get('session') == session:
        entry = t
        break

if not entry:
    # No trace for this session — can't generate
    sys.exit(1)

# Build note from trace data
platforms = entry.get('platforms_engaged', [])
agents = entry.get('agents_interacted', [])
topics = entry.get('topics', [])
skipped = entry.get('skipped_platforms', [])

# Session number for E# — count E sessions from history
e_num = '?'
try:
    with open('$HISTORY_FILE') as f:
        e_count = sum(1 for line in f if ' mode=E ' in line)
        e_num = str(e_count)
except:
    pass

parts = []
if platforms:
    parts.append('Engaged ' + ', '.join(platforms))
if agents:
    parts.append('interacted with ' + ', '.join(agents[:3]))
if topics:
    parts.append(topics[0])

summary = '; '.join(parts) if parts else 'engagement session completed'
# Truncate to reasonable length
if len(summary) > 150:
    summary = summary[:147] + '...'

print(f'Session E#{e_num} (s{session}) complete. {summary}.')
" 2>/dev/null) || exit 0

[ -n "$GENERATED_NOTE" ] || exit 0

# Replace the truncated note in session-history.txt
# Use python for safe string replacement (avoids sed escaping issues)
python3 -c "
import sys

history_file = '$HISTORY_FILE'
session_num = '$SESSION_NUM'
new_note = '''$GENERATED_NOTE'''

with open(history_file) as f:
    lines = f.readlines()

marker = f's={session_num} '
new_lines = []
for line in lines:
    if marker in line and 'note: ' in line:
        # Replace everything after 'note: ' with the generated note
        prefix = line[:line.index('note: ') + len('note: ')]
        new_lines.append(prefix + new_note + '\n')
    else:
        new_lines.append(line)

with open(history_file, 'w') as f:
    f.writelines(new_lines)

print(f'note-fallback: replaced truncated note for s{session_num}')
" 2>/dev/null || echo "note-fallback: failed to rewrite history (non-fatal)"
