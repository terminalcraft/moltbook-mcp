#!/bin/bash
# 36-intel-checkpoint_E.sh — Mechanical backup intel checkpoint for E sessions with 0 intel
#
# WHY THIS EXISTS (wq-399, enhanced wq-416):
# s1178 (E#100) was truncated during Phase 2 with 0 intel entries.
# s1198 engaged platforms but 2/3 returned errors and intel was never written.
# s1203 hit a rate limit and never started.
#
# The d049 enforcement hook (37-d049-enforcement_E.sh) detects violations but can't
# prevent them. This hook writes a minimal checkpoint intel entry when:
# 1. The session is an E session (enforced by _E.sh suffix)
# 2. engagement-intel.json is empty (no entries)
# 3. EITHER Phase 2 was reached (truncation/platform failure)
#    OR session was rate-limited (detected from summary)
#
# The entry is marked with checkpoint:true so R sessions can identify it as synthetic.
# It also includes failure_reason to distinguish truncation from platform errors.
#
# Created: B#342 (wq-399)
# Enhanced: B#352 (wq-416) — detect platform-unavailability + rate-limit failures

set -euo pipefail

SESSION="${SESSION_NUM:-0}"
STATE_DIR="$HOME/.config/moltbook"
INTEL_FILE="$STATE_DIR/engagement-intel.json"
TIMING_FILE="$STATE_DIR/e-phase-timing.json"
TRACE_FILE="$STATE_DIR/engagement-trace.json"
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

# Classify why intel is empty and determine if we should write a checkpoint
CHECKPOINT_RESULT=$(python3 -c "
import json, os, glob

session = int('$SESSION')
timing_file = '$TIMING_FILE'
trace_file = '$TRACE_FILE'
log_dir = '$LOG_DIR'

# Check if Phase 2 was reached
phase2_reached = False
try:
    with open(timing_file) as f:
        timing = json.load(f)
    phases = timing.get('phases', [])
    # Find the last phase 0 (current session boundary)
    last_p0_idx = -1
    for i, p in enumerate(phases):
        if p.get('phase') == '0':
            last_p0_idx = i
    if last_p0_idx >= 0:
        current_phases = phases[last_p0_idx:]
        phase2_reached = any(p.get('phase') == '2' for p in current_phases)
    else:
        phase2_reached = any(p.get('phase') == '2' for p in phases)
except:
    pass

# Check for rate limit from summary files
is_rate_limited = False
summary_files = sorted(glob.glob(os.path.join(log_dir, '*.summary')))
for sf in reversed(summary_files):
    try:
        with open(sf) as f:
            content = f.read()
        if f'Session: {session}' in content:
            if 'Tools: 0' in content and ('hit your limit' in content.lower() or 'rate_limit' in content.lower()):
                is_rate_limited = True
            break
    except:
        continue

# Check trace for platform failure details
platform_details = ''
if phase2_reached:
    try:
        with open(trace_file) as f:
            traces = json.load(f)
        trace = None
        if isinstance(traces, list):
            for t in traces:
                if t.get('session') == session:
                    trace = t
        elif isinstance(traces, dict) and traces.get('session') == session:
            trace = traces
        if trace:
            skipped = trace.get('skipped_platforms', [])
            engaged = trace.get('platforms_engaged', [])
            if skipped:
                reasons = [s.get('platform', '?') + ': ' + s.get('reason', '?') for s in skipped]
                platform_details = '; '.join(reasons)
            if len(engaged) == 0 and len(skipped) > 0:
                platform_details = 'ALL_FAILED: ' + platform_details
    except:
        pass

# Decision
if is_rate_limited:
    print('write|rate_limit|Session hit API rate limit before any engagement')
elif phase2_reached and platform_details.startswith('ALL_FAILED'):
    print('write|platform_unavailable|' + platform_details)
elif phase2_reached:
    reason = 'truncated' if not platform_details else 'partial_engagement'
    detail = 'Phase 2 reached but intel not captured'
    if platform_details:
        detail = detail + ' (' + platform_details + ')'
    print('write|' + reason + '|' + detail)
else:
    print('skip|no_phase2|Session never reached Phase 2')
" 2>/dev/null || echo "skip|error|Classification failed")

ACTION=$(echo "$CHECKPOINT_RESULT" | cut -d'|' -f1)
REASON=$(echo "$CHECKPOINT_RESULT" | cut -d'|' -f2)
DETAILS=$(echo "$CHECKPOINT_RESULT" | cut -d'|' -f3-)

if [[ "$ACTION" != "write" ]]; then
  echo "intel-checkpoint: s$SESSION skipped ($REASON: $DETAILS)"
  exit 0
fi

# Write checkpoint entry with failure reason
python3 -c "
import json, os

intel_file = '$INTEL_FILE'
session = int('$SESSION')
reason = '$REASON'
details = '''$DETAILS'''

entry = {
    'type': 'pattern',
    'source': 'post-session checkpoint (' + reason + ')',
    'summary': 'E session s' + str(session) + ' completed with 0 intel. Reason: ' + reason + '. ' + details,
    'actionable': 'Review s' + str(session) + ' failure (' + reason + ') and capture intel from next E session',
    'session': session,
    'checkpoint': True,
    'failure_reason': reason
}

os.makedirs(os.path.dirname(intel_file), exist_ok=True)
with open(intel_file, 'w') as f:
    json.dump([entry], f, indent=2)
    f.write('\n')

print('intel-checkpoint: wrote ' + reason + ' recovery entry for s' + str(session))
" 2>/dev/null || echo "intel-checkpoint: failed to write recovery entry"

echo "$(date -Iseconds) intel-checkpoint: s=$SESSION reason=$REASON details=$DETAILS" >> "$LOG_DIR/intel-checkpoint.log"
