#!/bin/bash
# 40-trace-fallback_E.sh — Generate minimal trace for E sessions that truncated before Phase 3
#
# Problem (wq-550):
# E sessions that truncate after 2min (bypassing 38-early-exit) but before Phase 3a
# (trace writing) leave no trace entry. Intel is captured inline during Phase 2,
# but verify-e-artifacts.mjs fails because engagement-trace.json has no session entry.
#
# Solution: After all other E hooks run, check if a trace entry exists for this session.
# If not, generate a minimal one from engagement-intel.json (which IS captured inline).
#
# Created: B#412 (wq-550)
set -euo pipefail

STATE_DIR="$HOME/.config/moltbook"
TRACE_FILE="$STATE_DIR/engagement-trace.json"
INTEL_FILE="$STATE_DIR/engagement-intel.json"
INTEL_ARCHIVE="$STATE_DIR/engagement-intel-archive.json"

: "${SESSION_NUM:?SESSION_NUM required}"
: "${MODE_CHAR:?MODE_CHAR required}"

# Check if trace entry already exists for this session
HAS_TRACE=$(python3 -c "
import json
session = int('$SESSION_NUM')
found = False
try:
    with open('$TRACE_FILE') as f:
        traces = json.load(f)
    if not isinstance(traces, list):
        traces = [traces] if isinstance(traces, dict) else []
    found = any(t.get('session') == session for t in traces)
except:
    pass
print('yes' if found else 'no')
" 2>/dev/null || echo "no")

if [ "$HAS_TRACE" = "yes" ]; then
  exit 0  # Trace exists, nothing to do
fi

# No trace for this session — generate minimal entry from intel
python3 -c "
import json, sys, os
from datetime import date

session = int('$SESSION_NUM')
trace_file = '$TRACE_FILE'
intel_file = '$INTEL_FILE'
archive_file = '$INTEL_ARCHIVE'

# Collect intel entries for this session
intel_entries = []
for path in [intel_file, archive_file]:
    try:
        with open(path) as f:
            data = json.load(f)
        entries = data if isinstance(data, list) else data.get('entries', [])
        for e in entries:
            if e.get('session') == session:
                intel_entries.append(e)
    except:
        pass

if not intel_entries:
    # No intel either — nothing to reconstruct from
    print(f'trace-fallback: s{session} has no intel entries, skipping')
    sys.exit(0)

# Extract platforms and topics from intel entries
platforms = list(set(
    e.get('platform') or e.get('source', 'unknown')
    for e in intel_entries
    if e.get('platform') or e.get('source')
))
topics = list(set(
    (e.get('learned') or e.get('summary', ''))[:60]
    for e in intel_entries
    if e.get('learned') or e.get('summary')
))

# Build minimal trace entry
trace_entry = {
    'session': session,
    'date': str(date.today()),
    'picker_mandate': [],
    'platforms_engaged': platforms,
    'skipped_platforms': [],
    'topics': topics[:5],
    'agents_interacted': [],
    'threads_contributed': [],
    'follow_ups': [],
    '_synthetic': True,
    '_source': 'trace-fallback hook (40-trace-fallback_E.sh)',
    '_reason': f'Session s{session} truncated before Phase 3a trace write'
}

# Load existing traces
try:
    with open(trace_file) as f:
        traces = json.load(f)
    if not isinstance(traces, list):
        traces = [traces] if isinstance(traces, dict) else []
except:
    traces = []

traces.append(trace_entry)

# Keep last 30 entries
if len(traces) > 30:
    traces = traces[-30:]

with open(trace_file, 'w') as f:
    json.dump(traces, f, indent=2)
    f.write('\n')

print(f'trace-fallback: generated synthetic trace for s{session} from {len(intel_entries)} intel entries, platforms: {platforms}')
" 2>/dev/null || echo "trace-fallback: failed to generate synthetic trace (non-fatal)"
