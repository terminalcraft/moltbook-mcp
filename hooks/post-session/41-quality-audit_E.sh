#!/bin/bash
# 41-quality-audit_E.sh — Auto-run post-quality-review --audit after E sessions
#
# Checks quality-scores.jsonl for entries from this session.
# If violations found, appends a follow_up to engagement-trace.json
# so the next E session sees the warning.
#
# Created: B#438 (wq-624, d066)
set -euo pipefail

: "${SESSION_NUM:?SESSION_NUM required}"

REPO_DIR="$HOME/moltbook-mcp"
STATE_DIR="$HOME/.config/moltbook"
TRACE_FILE="$STATE_DIR/engagement-trace.json"
HISTORY_FILE="$STATE_DIR/logs/quality-scores.jsonl"

# If no history file, nothing to audit
if [ ! -f "$HISTORY_FILE" ]; then
  echo "quality-audit: no quality history, skipping"
  exit 0
fi

# Count violations for this session
FAIL_COUNT=$(python3 -c "
import json, sys
session = int('$SESSION_NUM')
fails = 0
try:
    with open('$HISTORY_FILE') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                if entry.get('session') == session and entry.get('verdict') == 'FAIL':
                    fails += 1
            except:
                pass
except:
    pass
print(fails)
" 2>/dev/null || echo "0")

WARN_COUNT=$(python3 -c "
import json, sys
session = int('$SESSION_NUM')
warns = 0
try:
    with open('$HISTORY_FILE') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                if entry.get('session') == session and entry.get('verdict') == 'WARN':
                    warns += 1
            except:
                pass
except:
    pass
print(warns)
" 2>/dev/null || echo "0")

TOTAL_COUNT=$(python3 -c "
import json, sys
session = int('$SESSION_NUM')
total = 0
try:
    with open('$HISTORY_FILE') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                if entry.get('session') == session:
                    total += 1
            except:
                pass
except:
    pass
print(total)
" 2>/dev/null || echo "0")

if [ "$TOTAL_COUNT" = "0" ]; then
  echo "quality-audit: s$SESSION_NUM had no quality-checked posts"
  exit 0
fi

echo "quality-audit: s$SESSION_NUM — $TOTAL_COUNT posts checked, $FAIL_COUNT fails, $WARN_COUNT warns"

# If any failures, append follow_up to engagement-trace.json
if [ "$FAIL_COUNT" -gt 0 ] && [ -f "$TRACE_FILE" ]; then
  python3 -c "
import json, sys

session = int('$SESSION_NUM')
fail_count = int('$FAIL_COUNT')
warn_count = int('$WARN_COUNT')
total = int('$TOTAL_COUNT')
trace_file = '$TRACE_FILE'

try:
    with open(trace_file) as f:
        traces = json.load(f)
    if not isinstance(traces, list):
        traces = [traces] if isinstance(traces, dict) else []
except:
    traces = []

# Find this session's trace entry and add follow_up
for trace in reversed(traces):
    if trace.get('session') == session:
        if 'follow_ups' not in trace:
            trace['follow_ups'] = []
        trace['follow_ups'].append({
            'type': 'quality_warning',
            'message': f's{session} quality gate: {fail_count}/{total} posts FAILED quality review. Review violations in quality-scores.jsonl and avoid repeating flagged patterns.',
            'severity': 'high' if fail_count > 1 else 'medium',
            'source': '41-quality-audit_E.sh'
        })
        break

with open(trace_file, 'w') as f:
    json.dump(traces, f, indent=2)
    f.write('\n')

print(f'quality-audit: appended follow_up to trace for s{session}')
" 2>/dev/null || echo "quality-audit: failed to append follow_up (non-fatal)"
fi

exit 0
