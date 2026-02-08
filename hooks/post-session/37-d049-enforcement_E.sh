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
# ARCHITECTURE NOTE (wq-430, B#363):
# As of wq-430, intel capture is INLINE during Phase 2 (per-platform, using
# inline-intel-capture.mjs) rather than deferred to Phase 3b. This hook now
# primarily serves as a safety net for sessions that bypass inline capture.
# With inline capture, trace_without_intel should become rare.
#
# Created: B#330 (wq-375)
# Enhanced: B#352 (wq-416) — failure mode classification
# Enhanced: B#356 (wq-425) — trace_without_intel failure mode
# Updated: B#363 (wq-430) — inline intel architecture note
#   Distinguishes between:
#   - rate_limit: session hit API rate limit (0 tool calls, <10s duration)
#   - platform_unavailable: Phase 2 reached but all platforms errored
#   - trace_without_intel: trace written but intel missed (should be rare post-wq-430)
#   - agent_skip: Phase 2+ reached with budget, no trace, agent didn't capture intel

set -euo pipefail

# Session-type filtering handled by run-hooks.sh (_E.sh suffix).
# Previous versions checked SESSION_TYPE env var which was never passed by heartbeat.sh,
# causing the hook to silently exit 0 for all real E sessions. Fixed in B#335 (wq-383).

SESSION="${SESSION_NUM:-0}"
STATE_DIR="$HOME/.config/moltbook"
INTEL_FILE="$STATE_DIR/engagement-intel.json"
TRACKING_FILE="$(dirname "$(dirname "$(dirname "$(realpath "$0")")")")/e-phase35-tracking.json"
NUDGE_FILE="$STATE_DIR/d049-nudge.txt"
TIMING_FILE="$STATE_DIR/e-phase-timing.json"
TRACE_FILE="$STATE_DIR/engagement-trace.json"
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

# Classify failure mode when non-compliant (wq-416)
FAILURE_MODE="none"
if [[ "$D049_COMPLIANT" == "false" ]]; then
  FAILURE_MODE=$(python3 -c "
import json, os, glob

session = int('$SESSION')
state_dir = '$STATE_DIR'
timing_file = '$TIMING_FILE'
trace_file = '$TRACE_FILE'
log_dir = '$LOG_DIR'

# Check 1: Did the session reach Phase 2?
phase2_reached = False
try:
    with open(timing_file) as f:
        timing = json.load(f)
    # Check if any phase 2 entry belongs to current session window
    # (timing file accumulates across sessions, check most recent phase 0)
    phases = timing.get('phases', [])
    # Find the last phase 0 start (marks current session start)
    last_p0_idx = -1
    for i, p in enumerate(phases):
        if p.get('phase') == '0':
            last_p0_idx = i
    if last_p0_idx >= 0:
        current_phases = phases[last_p0_idx:]
        phase2_reached = any(p.get('phase') == '2' for p in current_phases)
except:
    pass

# Check 2: Was the session a rate-limit / zero-tool-call failure?
# Look for the session summary file — rate-limited sessions have 'Tools: 0'
# and contain rate limit messages
is_rate_limited = False
summary_files = sorted(glob.glob(os.path.join(log_dir, '*.summary')))
for sf in reversed(summary_files):
    try:
        with open(sf) as f:
            content = f.read()
        if f'Session: {session}' in content:
            if 'Tools: 0' in content and ('hit your limit' in content.lower() or 'rate_limit' in content.lower() or 'resets' in content.lower()):
                is_rate_limited = True
            break
    except:
        continue

# Check 3: Trace analysis — platform availability + trace_without_intel (wq-425)
all_platforms_failed = False
trace_present = False
if phase2_reached:
    try:
        with open(trace_file) as f:
            traces = json.load(f)
        session_trace = None
        if isinstance(traces, list):
            for t in traces:
                if t.get('session') == session:
                    session_trace = t
        elif isinstance(traces, dict) and traces.get('session') == session:
            session_trace = traces
        if session_trace:
            trace_present = True
            engaged = session_trace.get('platforms_engaged', [])
            skipped = session_trace.get('skipped_platforms', [])
            mandate = session_trace.get('picker_mandate', [])
            if len(mandate) > 0 and len(engaged) == 0 and len(skipped) == len(mandate):
                all_platforms_failed = True
    except:
        pass

# Classify failure mode
# trace_without_intel (wq-425): s1198, s1213 wrote engagement-trace.json (Phase 3a)
# but session ended before intel capture (Phase 3b). The agent DID complete engagement
# and trace writing — it ran out of time/turns before reaching intel capture.
# This is distinct from agent_skip (no trace written, agent simply didn't try).
if is_rate_limited:
    print('rate_limit')
elif not phase2_reached:
    print('truncated_early')
elif all_platforms_failed:
    print('platform_unavailable')
elif trace_present:
    print('trace_without_intel')
elif phase2_reached:
    print('agent_skip')
else:
    print('unknown')
" 2>/dev/null || echo "unknown")
fi

echo "$(date -Iseconds) d049-enforcement: s=$SESSION intel_count=$INTEL_COUNT compliant=$D049_COMPLIANT failure_mode=$FAILURE_MODE" >> "$LOG_DIR/d049-enforcement.log"

# Update e-phase35-tracking.json with authoritative data + failure mode
{
  python3 -c "
import json, sys

tracking_file = '$TRACKING_FILE'
session = int('$SESSION')
intel_count = int('$INTEL_COUNT')
compliant = intel_count > 0
failure_mode = '$FAILURE_MODE'

try:
    with open(tracking_file) as f:
        tracking = json.load(f)
except:
    tracking = {'sessions': []}

sessions = tracking.get('sessions', [])

# Check if session already tracked
existing = [s for s in sessions if s.get('session') == session]
if existing:
    existing[0]['d049_compliant'] = compliant
    existing[0]['intel_count'] = intel_count
    existing[0]['enforcement'] = 'post-hook'
    if failure_mode != 'none':
        existing[0]['failure_mode'] = failure_mode
else:
    e_num = len([s for s in sessions if s.get('session', 0) < session]) + 1
    for s in sessions:
        if s.get('e_number', 0) >= e_num:
            e_num = s['e_number'] + 1
    entry = {
        'session': session,
        'e_number': e_num,
        'd049_compliant': compliant,
        'intel_count': intel_count,
        'enforcement': 'post-hook',
        'notes': f'Post-hook enforcement: {intel_count} intel entries captured'
    }
    if failure_mode != 'none':
        entry['failure_mode'] = failure_mode
        mode_labels = {
            'rate_limit': 'Rate-limited — session could not start',
            'truncated_early': 'Truncated before Phase 2',
            'platform_unavailable': 'All picker platforms returned errors',
            'trace_without_intel': 'Trace written (Phase 3a) but session ended before intel capture (Phase 3b)',
            'agent_skip': 'Agent reached Phase 2 but did not capture intel (no trace either)',
            'unknown': 'Failure mode could not be determined'
        }
        entry['notes'] = f'd049 violation ({failure_mode}): {mode_labels.get(failure_mode, failure_mode)}'
    sessions.append(entry)

tracking['sessions'] = sessions
with open(tracking_file, 'w') as f:
    json.dump(tracking, f, indent=2)
    f.write('\n')

print(f'd049-enforcement: updated tracking for s{session} (compliant={compliant}, count={intel_count}, failure_mode={failure_mode})')
" 2>/dev/null || echo "d049-enforcement: failed to update tracking"
}

# Write nudge for next E session if violated — but only for controllable failures
if [[ "$D049_COMPLIANT" == "false" ]]; then
  if [[ "$FAILURE_MODE" == "rate_limit" ]]; then
    echo "d049-enforcement: s$SESSION was rate-limited (uncontrollable), no nudge written"
  elif [[ "$FAILURE_MODE" == "truncated_early" ]]; then
    echo "d049-enforcement: s$SESSION truncated before Phase 2 (uncontrollable), no nudge written"
  elif [[ "$FAILURE_MODE" == "trace_without_intel" ]]; then
    cat > "$NUDGE_FILE" << EOF
## d049 WARNING: trace_without_intel (from post-session hook)

Previous E session (s$SESSION) wrote an engagement trace but captured 0 intel entries.
The session completed Phase 3a (trace) but ended before Phase 3b (intel capture).

**PREVENTION**: Call \`node e-intel-checkpoint.mjs <platform> "<summary>"\` after your
FIRST platform interaction in Phase 2. This is your safety net — don't rely on
reaching Phase 3b to capture intel.

**ALSO**: Write intel entries to engagement-intel.json IMMEDIATELY after writing
your engagement trace in Phase 3a. Don't separate trace and intel with other operations.
EOF
    echo "d049-enforcement: trace_without_intel nudge written for next E session (s$SESSION)"
  else
    cat > "$NUDGE_FILE" << EOF
## d049 VIOLATION ALERT (from post-session hook)

Previous E session (s$SESSION) completed with 0 intel entries.
Failure mode: $FAILURE_MODE
This is a violation of d049 (minimum 1 intel entry per E session).

**YOU MUST capture at least 1 intel entry this session.**

Do this IMMEDIATELY after your first platform engagement (Phase 2), not at the end.
Don't wait for Phase 3b — capture intel as you go:
- After each platform interaction, note one actionable observation
- Write it to engagement-intel.json BEFORE moving to the next platform

If you reach Phase 3a without any intel entries, STOP and go back to capture intel.
EOF
    echo "d049-enforcement: nudge written for next E session (violation in s$SESSION, mode=$FAILURE_MODE)"
  fi
else
  # Clear nudge if compliant
  rm -f "$NUDGE_FILE"
  echo "d049-enforcement: compliant, nudge cleared"
fi
