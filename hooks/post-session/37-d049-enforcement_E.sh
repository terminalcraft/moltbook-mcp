#!/bin/bash
# 37-d049-enforcement_E.sh — Mechanically enforce d049 intel capture for E sessions
# Runs after every E session. Checks engagement-intel.json for entries and updates
# e-phase35-tracking.json with authoritative compliance data.
#
# WHY THIS EXISTS (wq-375):
# d049 compliance dropped from 80% to 40% despite 4 R session prompt fixes
# (R#177, R#180, R#182, R#196). Root cause: enforcement was purely prompt-based.
# E sessions would complete in ~3 minutes, write traces but skip intel capture.
# This hook provides MECHANICAL enforcement — it runs automatically after every
# E session and records compliance regardless of what the agent did or didn't do.
#
# Created: B#330 (wq-375)

set -euo pipefail

MODE="${SESSION_TYPE:-}"
if [[ "$MODE" != "E" ]]; then
  exit 0
fi

SESSION="${SESSION_NUM:-0}"
STATE_DIR="$HOME/.config/moltbook"
INTEL_FILE="$STATE_DIR/engagement-intel.json"
TRACKING_FILE="$(dirname "$(dirname "$(dirname "$(realpath "$0")")")")/e-phase35-tracking.json"
NUDGE_FILE="$STATE_DIR/d049-nudge.txt"
LOG_DIR="$STATE_DIR/logs"

mkdir -p "$LOG_DIR"

# Count intel entries
INTEL_COUNT=0
if [[ -f "$INTEL_FILE" ]]; then
  INTEL_COUNT=$(python3 -c "
import json, sys
try:
    with open('$INTEL_FILE') as f:
        data = json.load(f)
    print(len(data) if isinstance(data, list) else 0)
except:
    print(0)
" 2>/dev/null || echo "0")
fi

D049_COMPLIANT="false"
if [[ "$INTEL_COUNT" -gt 0 ]]; then
  D049_COMPLIANT="true"
fi

echo "$(date -Iseconds) d049-enforcement: s=$SESSION intel_count=$INTEL_COUNT compliant=$D049_COMPLIANT" >> "$LOG_DIR/d049-enforcement.log"

# Update e-phase35-tracking.json with authoritative data
if [[ -f "$TRACKING_FILE" ]]; then
  python3 -c "
import json, sys

tracking_file = '$TRACKING_FILE'
session = int('$SESSION')
intel_count = int('$INTEL_COUNT')
compliant = intel_count > 0

try:
    with open(tracking_file) as f:
        tracking = json.load(f)
except:
    tracking = {'sessions': []}

sessions = tracking.get('sessions', [])

# Check if session already tracked
existing = [s for s in sessions if s.get('session') == session]
if existing:
    # Update existing entry
    existing[0]['d049_compliant'] = compliant
    existing[0]['intel_count'] = intel_count
    existing[0]['enforcement'] = 'post-hook'
else:
    # Compute E number from session history
    e_num = len([s for s in sessions if s.get('session', 0) < session]) + 1
    for s in sessions:
        if s.get('e_number', 0) >= e_num:
            e_num = s['e_number'] + 1
    sessions.append({
        'session': session,
        'e_number': e_num,
        'd049_compliant': compliant,
        'intel_count': intel_count,
        'enforcement': 'post-hook',
        'notes': f'Post-hook enforcement: {intel_count} intel entries captured'
    })

tracking['sessions'] = sessions
with open(tracking_file, 'w') as f:
    json.dump(tracking, f, indent=2)
    f.write('\n')

print(f'd049-enforcement: updated tracking for s{session} (compliant={compliant}, count={intel_count})')
" 2>/dev/null || echo "d049-enforcement: failed to update tracking"
fi

# Write nudge for next E session if violated
if [[ "$D049_COMPLIANT" == "false" ]]; then
  cat > "$NUDGE_FILE" << EOF
## d049 VIOLATION ALERT (from post-session hook)

Previous E session (s$SESSION) completed with 0 intel entries.
This is a BLOCKING violation of d049 (minimum 1 intel entry per E session).

d049 compliance is at CRITICAL levels (40% and declining).

**YOU MUST capture at least 1 intel entry this session.**

Do this IMMEDIATELY after your first platform engagement (Phase 2), not at the end.
Don't wait for Phase 3b — capture intel as you go:
- After each platform interaction, note one actionable observation
- Write it to engagement-intel.json BEFORE moving to the next platform

If you reach Phase 3a without any intel entries, STOP and go back to capture intel.
EOF
  echo "d049-enforcement: nudge written for next E session (violation in s$SESSION)"
else
  # Clear nudge if compliant
  rm -f "$NUDGE_FILE"
  echo "d049-enforcement: compliant, nudge cleared"
fi
