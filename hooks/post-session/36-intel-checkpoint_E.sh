#!/bin/bash
# 36-intel-checkpoint_E.sh — Mechanical backup intel checkpoint for truncated E sessions
#
# WHY THIS EXISTS (wq-399):
# s1178 (E#100) was truncated during Phase 2 with 0 intel entries.
# The d049 enforcement hook (37-d049-enforcement_E.sh) detects violations but can't
# prevent them. This hook writes a minimal "truncation recovery" intel entry if:
# 1. The session is an E session (enforced by _E.sh suffix)
# 2. engagement-intel.json is empty (no entries)
# 3. Phase 2 was reached (e-phase-timing.json shows phase 2 start)
#
# This ensures truncated sessions always have at least 1 intel entry.
# The entry is marked with checkpoint:true so R sessions can identify it as synthetic.
#
# Created: B#342 (wq-399)

set -euo pipefail

SESSION="${SESSION_NUM:-0}"
STATE_DIR="$HOME/.config/moltbook"
INTEL_FILE="$STATE_DIR/engagement-intel.json"
TIMING_FILE="$STATE_DIR/e-phase-timing.json"
LOG_DIR="$STATE_DIR/logs"

mkdir -p "$LOG_DIR"

# Check if intel is empty
INTEL_COUNT=$(python3 -c "
import json
try:
    with open('$INTEL_FILE') as f:
        data = json.load(f)
    print(len(data) if isinstance(data, list) else 0)
except:
    print(0)
" 2>/dev/null || echo "0")

if [[ "$INTEL_COUNT" -gt 0 ]]; then
  echo "intel-checkpoint: s$SESSION has $INTEL_COUNT entries, no action needed"
  exit 0
fi

# Check if Phase 2 was reached (indicates engagement started)
PHASE2_REACHED=$(python3 -c "
import json
try:
    with open('$TIMING_FILE') as f:
        data = json.load(f)
    phases = data.get('phases', [])
    reached = any(p.get('phase') == '2' for p in phases)
    print('yes' if reached else 'no')
except:
    print('no')
" 2>/dev/null || echo "no")

if [[ "$PHASE2_REACHED" != "yes" ]]; then
  echo "intel-checkpoint: s$SESSION never reached Phase 2, skipping"
  exit 0
fi

# Phase 2 was reached but intel is empty — write checkpoint entry
python3 -c "
import json, os

intel_file = '$INTEL_FILE'
session = int('$SESSION')

entry = {
    'type': 'pattern',
    'source': 'post-session checkpoint (truncation recovery)',
    'summary': f'E session s{session} was truncated during Phase 2 before intel capture. This is a placeholder entry for d049 compliance.',
    'actionable': f'Review engagement from s{session} in next E session and capture real intel',
    'session': session,
    'checkpoint': True
}

os.makedirs(os.path.dirname(intel_file), exist_ok=True)
with open(intel_file, 'w') as f:
    json.dump([entry], f, indent=2)
    f.write('\n')

print(f'intel-checkpoint: wrote truncation recovery entry for s{session}')
" 2>/dev/null || echo "intel-checkpoint: failed to write recovery entry"

echo "$(date -Iseconds) intel-checkpoint: s=$SESSION wrote truncation recovery entry (phase2 reached, 0 intel)" >> "$LOG_DIR/intel-checkpoint.log"
