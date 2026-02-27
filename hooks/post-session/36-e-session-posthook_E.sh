#!/bin/bash
# 36-e-session-posthook_E.sh — Consolidated E-session post-hook dispatcher
#
# Merges 7 individual E-session hooks into a single dispatcher that parses
# shared JSON files once and runs all checks sequentially. Reduces hook count
# and eliminates repeated JSON parsing overhead.
#
# Replaces:
#   36-intel-checkpoint_E.sh   (wq-399, wq-416, wq-425, wq-430)
#   37-d049-enforcement_E.sh   (wq-375, wq-416, wq-425, wq-430)
#   38-early-exit_E.sh         (wq-423, wq-428)
#   39-note-fallback_E.sh      (wq-451)
#   40-trace-fallback_E.sh     (wq-550)
#   41-quality-audit_E.sh      (wq-624, d066)
#   42-quality-enforce_E.sh    (wq-632, d066)
#   31-covenant-update_E.sh    (wq-220) — merged B#483 (wq-727)
#   37-scope-bleed-detect_E.sh (wq-712) — merged B#483 (wq-727)
#
# Created: B#459 (wq-662)
set -euo pipefail

: "${SESSION_NUM:?SESSION_NUM required}"
: "${MODE_CHAR:?MODE_CHAR required}"

export SESSION="$SESSION_NUM"
export STATE_DIR="$HOME/.config/moltbook"
export LOG_DIR="$STATE_DIR/logs"
MCP_DIR="$(dirname "$(dirname "$(dirname "$(realpath "$0")")")")"

export INTEL_FILE="$STATE_DIR/engagement-intel.json"
export TRACE_FILE="$STATE_DIR/engagement-trace.json"
export TIMING_FILE="$STATE_DIR/e-phase-timing.json"
export HISTORY_FILE="$STATE_DIR/session-history.txt"
export TRACKING_FILE="$MCP_DIR/e-phase35-tracking.json"
export NUDGE_FILE="$STATE_DIR/d049-nudge.txt"
export QUALITY_SCORES="$LOG_DIR/quality-scores.jsonl"
export ENFORCE_FILE="$LOG_DIR/quality-enforcement.jsonl"

mkdir -p "$LOG_DIR"

###############################################################################
# Phase 1: Parse shared JSON files ONCE — store in temp file for safe access
###############################################################################

export PARSED_FILE=$(mktemp)
trap 'rm -f "$PARSED_FILE"' EXIT

# All parsed data stored in a single python pass to avoid repeated subprocess spawns
python3 << 'PYEOF' > "$PARSED_FILE"
import json, sys, os, glob
from datetime import date

session = int(os.environ['SESSION_NUM'])
state_dir = os.environ.get('STATE_DIR', os.path.expanduser('~/.config/moltbook'))
intel_file = os.path.join(state_dir, 'engagement-intel.json')
trace_file = os.path.join(state_dir, 'engagement-trace.json')
timing_file = os.path.join(state_dir, 'e-phase-timing.json')
history_file = os.path.join(state_dir, 'session-history.txt')
log_dir = os.path.join(state_dir, 'logs')
quality_file = os.path.join(log_dir, 'quality-scores.jsonl')

result = {}

# --- Intel count ---
intel_count = 0
intel_entries = []
try:
    with open(intel_file) as f:
        data = json.load(f)
    if isinstance(data, list):
        intel_count = len(data)
        intel_entries = data
except:
    pass
result['intel_count'] = intel_count

# --- Trace for this session ---
session_trace = None
all_traces = []
try:
    with open(trace_file) as f:
        traces = json.load(f)
    if isinstance(traces, list):
        all_traces = traces
        for t in traces:
            if t.get('session') == session:
                session_trace = t
    elif isinstance(traces, dict) and traces.get('session') == session:
        session_trace = traces
        all_traces = [traces]
except:
    pass
result['has_trace'] = session_trace is not None
result['trace_platforms_engaged'] = session_trace.get('platforms_engaged', []) if session_trace else []
result['trace_skipped_platforms'] = session_trace.get('skipped_platforms', []) if session_trace else []
result['trace_topics'] = session_trace.get('topics', []) if session_trace else []
result['trace_agents'] = session_trace.get('agents_interacted', []) if session_trace else []
result['trace_picker_mandate'] = session_trace.get('picker_mandate', []) if session_trace else []

# --- Phase 2 reached? ---
phase2_reached = False
try:
    with open(timing_file) as f:
        timing = json.load(f)
    phases = timing.get('phases', [])
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
result['phase2_reached'] = phase2_reached

# --- Rate limit detection ---
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
result['is_rate_limited'] = is_rate_limited

# --- Platform failure analysis ---
all_platforms_failed = False
if phase2_reached and session_trace:
    engaged = session_trace.get('platforms_engaged', [])
    skipped = session_trace.get('skipped_platforms', [])
    mandate = session_trace.get('picker_mandate', [])
    if len(mandate) > 0 and len(engaged) == 0 and len(skipped) == len(mandate):
        all_platforms_failed = True
result['all_platforms_failed'] = all_platforms_failed

# Build platform_details string for intel-checkpoint
platform_details = ''
if phase2_reached and session_trace:
    skipped = session_trace.get('skipped_platforms', [])
    engaged = session_trace.get('platforms_engaged', [])
    if skipped:
        reasons = [s.get('platform', '?') + ': ' + s.get('reason', '?') for s in skipped if isinstance(s, dict)]
        platform_details = '; '.join(reasons)
    if len(engaged) == 0 and len(skipped) > 0:
        platform_details = 'ALL_FAILED: ' + platform_details
result['platform_details'] = platform_details

# --- Failure mode classification ---
if intel_count > 0:
    failure_mode = 'none'
elif is_rate_limited:
    failure_mode = 'rate_limit'
elif not phase2_reached:
    failure_mode = 'truncated_early'
elif all_platforms_failed:
    failure_mode = 'platform_unavailable'
elif session_trace is not None:
    failure_mode = 'trace_without_intel'
elif phase2_reached:
    failure_mode = 'agent_skip'
else:
    failure_mode = 'unknown'
result['failure_mode'] = failure_mode

# --- Session duration from summary (for early-exit check) ---
log_file = os.environ.get('LOG_FILE', '')
summary_file = log_file.replace('.log', '.summary') if log_file else ''
total_seconds = -1
duration_str = ''
if summary_file and os.path.isfile(summary_file):
    try:
        with open(summary_file) as f:
            for line in f:
                if line.startswith('Duration:'):
                    duration_str = line.split()[1].strip().lstrip('~')
                    mins = 0
                    secs = 0
                    import re
                    m = re.search(r'(\d+)m', duration_str)
                    if m: mins = int(m.group(1))
                    s = re.search(r'(\d+)s', duration_str)
                    if s: secs = int(s.group(1))
                    total_seconds = mins * 60 + secs
                    break
    except:
        pass
result['duration_str'] = duration_str
result['total_seconds'] = total_seconds

# --- History note for this session (for note-fallback) ---
current_note = ''
try:
    with open(history_file) as f:
        for line in f:
            if f's={session} ' in line and 'note: ' in line:
                idx = line.index('note: ') + len('note: ')
                current_note = line[idx:].strip()
except:
    pass
result['current_note'] = current_note

# --- E session count (for note generation) ---
e_count = 0
try:
    with open(history_file) as f:
        e_count = sum(1 for line in f if ' mode=E ' in line)
except:
    pass
result['e_count'] = e_count

# --- Quality scores for this session ---
session_fails = 0
session_warns = 0
session_total = 0
try:
    with open(quality_file) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                if entry.get('session') == session:
                    session_total += 1
                    if entry.get('verdict') == 'FAIL':
                        session_fails += 1
                    elif entry.get('verdict') == 'WARN':
                        session_warns += 1
            except:
                pass
except:
    pass
result['quality_session_fails'] = session_fails
result['quality_session_warns'] = session_warns
result['quality_session_total'] = session_total

# --- Trace intel extraction data (for intel-checkpoint) ---
trace_intel_data = None
if intel_count == 0 and session_trace:
    topics = session_trace.get('topics', [])
    agents = session_trace.get('agents_interacted', [])
    platforms = session_trace.get('platforms_engaged', [])
    if topics:
        platform_str = ', '.join(platforms) if platforms else 'unknown platform'
        agent_str = ', '.join(agents[:3]) if agents else 'various agents'
        topic_str = topics[0] if topics else 'general discussion'
        trace_intel_data = {
            'type': 'pattern',
            'source': f'{platform_str} (extracted from trace by checkpoint hook)',
            'summary': f'Engagement on {platform_str} covering: {topic_str}. Agents: {agent_str}.',
            'actionable': f'Evaluate {platform_str} discussion topics for build opportunities in next E session',
            'session': session,
            'checkpoint': True,
            'extracted_from_trace': True,
            'failure_reason': failure_mode
        }
result['trace_intel_data'] = trace_intel_data

# --- Intel archive entries for trace-fallback ---
archive_intel = []
archive_file = os.path.join(state_dir, 'engagement-intel-archive.json')
for path in [intel_file, archive_file]:
    try:
        with open(path) as f:
            data = json.load(f)
        entries = data if isinstance(data, list) else data.get('entries', [])
        for e in entries:
            if e.get('session') == session:
                archive_intel.append(e)
    except:
        pass
result['archive_intel_count'] = len(archive_intel)
result['archive_intel_platforms'] = list(set(
    e.get('platform') or e.get('source', 'unknown')
    for e in archive_intel
    if e.get('platform') or e.get('source')
))
result['archive_intel_topics'] = list(set(
    (e.get('learned') or e.get('summary', ''))[:60]
    for e in archive_intel
    if e.get('learned') or e.get('summary')
))[:5]

json.dump(result, sys.stdout)
PYEOF

if [[ ! -s "$PARSED_FILE" ]]; then
  echo "e-posthook: CRITICAL — JSON parse phase failed"
  exit 1
fi

# Extract parsed values into shell variables (single python3 call, not 17)
SHELL_VARS=$(python3 << 'EXTRACT_PY' 2>/dev/null
import json, os, shlex

d = json.load(open(os.environ['PARSED_FILE']))

def boolstr(v):
    return 'true' if v else 'false'

def safe(v, default=''):
    s = str(v) if v is not None else default
    return shlex.quote(s)

print(f"INTEL_COUNT={int(d.get('intel_count', 0))}")
print(f"HAS_TRACE={boolstr(d.get('has_trace'))}")
print(f"PHASE2_REACHED={boolstr(d.get('phase2_reached'))}")
print(f"IS_RATE_LIMITED={boolstr(d.get('is_rate_limited'))}")
print(f"ALL_PLATFORMS_FAILED={boolstr(d.get('all_platforms_failed'))}")
print(f"FAILURE_MODE={safe(d.get('failure_mode', 'unknown'))}")
print(f"PLATFORM_DETAILS={safe(d.get('platform_details', ''))}")
print(f"TOTAL_SECONDS={int(d.get('total_seconds', -1))}")
print(f"DURATION_STR={safe(d.get('duration_str', ''))}")
print(f"CURRENT_NOTE={safe(d.get('current_note', ''))}")
print(f"E_COUNT={int(d.get('e_count', 0))}")
print(f"Q_FAILS={int(d.get('quality_session_fails', 0))}")
print(f"Q_WARNS={int(d.get('quality_session_warns', 0))}")
print(f"Q_TOTAL={int(d.get('quality_session_total', 0))}")
print(f"ARCHIVE_INTEL_COUNT={int(d.get('archive_intel_count', 0))}")
EXTRACT_PY
)

if [[ -z "$SHELL_VARS" ]]; then
  echo "e-posthook: CRITICAL — variable extraction failed"
  exit 1
fi

# Safe eval: only accept lines matching KEY=value pattern (per d061 rule)
eval "$(echo "$SHELL_VARS" | grep '^[A-Z_]*=')"

D049_COMPLIANT="false"
[[ "$INTEL_COUNT" -gt 0 ]] && D049_COMPLIANT="true"

###############################################################################
# Check 1: Intel checkpoint (was 36-intel-checkpoint_E.sh)
#   Last-resort safety net — writes minimal intel when session has 0 entries
###############################################################################
check_intel_checkpoint() {
  if [[ "$INTEL_COUNT" -gt 0 ]]; then
    echo "intel-checkpoint: s$SESSION has $INTEL_COUNT entries, no action needed"
    return
  fi

  # Determine if we should write a checkpoint
  local action="skip" reason="no_phase2" details="Session never reached Phase 2"

  if [[ "$IS_RATE_LIMITED" == "true" ]]; then
    action="write"; reason="rate_limit"; details="Session hit API rate limit before any engagement"
  elif [[ "$PHASE2_REACHED" == "true" && "$PLATFORM_DETAILS" == ALL_FAILED* ]]; then
    action="write"; reason="platform_unavailable"; details="$PLATFORM_DETAILS"
  elif [[ "$PHASE2_REACHED" == "true" ]]; then
    if [[ -n "$PLATFORM_DETAILS" ]]; then
      reason="partial_engagement"; details="Phase 2 reached but intel not captured ($PLATFORM_DETAILS)"
    else
      reason="truncated"; details="Phase 2 reached but intel not captured"
    fi
    action="write"
  fi

  if [[ "$action" != "write" ]]; then
    echo "intel-checkpoint: s$SESSION skipped ($reason: $details)"
    return
  fi

  # Write checkpoint entry — uses PARSED_FILE for trace_intel_data
  INTEL_REASON="$reason" INTEL_DETAILS="$details" python3 << 'CHECKPOINT_PY' 2>/dev/null || echo "intel-checkpoint: failed to write recovery entry"
import json, os

intel_file = os.environ['INTEL_FILE']
session = int(os.environ['SESSION'])
reason = os.environ['INTEL_REASON']
details = os.environ['INTEL_DETAILS']
parsed_file = os.environ['PARSED_FILE']

parsed = json.load(open(parsed_file))
trace_intel = parsed.get('trace_intel_data')

if trace_intel:
    entry = trace_intel
else:
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

source_label = 'trace-extracted' if trace_intel else reason
print('intel-checkpoint: wrote ' + source_label + ' recovery entry for s' + str(session))
CHECKPOINT_PY

  echo "$(date -Iseconds) intel-checkpoint: s=$SESSION reason=$reason details=$details" >> "$LOG_DIR/intel-checkpoint.log"
}

###############################################################################
# Check 2: d049 enforcement (was 37-d049-enforcement_E.sh)
#   Records compliance, writes nudge for next E session if violated
###############################################################################
check_d049_enforcement() {
  echo "$(date -Iseconds) d049-enforcement: s=$SESSION intel_count=$INTEL_COUNT compliant=$D049_COMPLIANT failure_mode=$FAILURE_MODE" >> "$LOG_DIR/d049-enforcement.log"

  # Update e-phase35-tracking.json
  python3 -c "
import json

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

  # Write or clear nudge
  if [[ "$D049_COMPLIANT" == "false" ]]; then
    if [[ "$FAILURE_MODE" == "rate_limit" ]]; then
      echo "d049-enforcement: s$SESSION was rate-limited (uncontrollable), no nudge written"
    elif [[ "$FAILURE_MODE" == "truncated_early" ]]; then
      echo "d049-enforcement: s$SESSION truncated before Phase 2 (uncontrollable), no nudge written"
    elif [[ "$FAILURE_MODE" == "trace_without_intel" ]]; then
      cat > "$NUDGE_FILE" << NUDGE_EOF
## d049 WARNING: trace_without_intel (from post-session hook)

Previous E session (s$SESSION) wrote an engagement trace but captured 0 intel entries.
The session completed Phase 3a (trace) but ended before Phase 3b (intel capture).

**PREVENTION**: Call \`node e-intel-checkpoint.mjs <platform> "<summary>"\` after your
FIRST platform interaction in Phase 2. This is your safety net — don't rely on
reaching Phase 3b to capture intel.

**ALSO**: Write intel entries to engagement-intel.json IMMEDIATELY after writing
your engagement trace in Phase 3a. Don't separate trace and intel with other operations.
NUDGE_EOF
      echo "d049-enforcement: trace_without_intel nudge written for next E session (s$SESSION)"
    else
      cat > "$NUDGE_FILE" << NUDGE_EOF
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
NUDGE_EOF
      echo "d049-enforcement: nudge written for next E session (violation in s$SESSION, mode=$FAILURE_MODE)"
    fi
  else
    rm -f "$NUDGE_FILE"
    echo "d049-enforcement: compliant, nudge cleared"
  fi
}

###############################################################################
# Check 3: Early exit detection (was 38-early-exit_E.sh)
#   Flags sessions <120s and injects stigmergic pressure into trace
###############################################################################
check_early_exit() {
  if [[ "$TOTAL_SECONDS" -lt 0 ]]; then
    return  # No duration info available
  fi

  if [[ "$TOTAL_SECONDS" -ge 120 ]]; then
    return  # Not an early exit
  fi

  echo "$(date -Iseconds) s=$SESSION dur=${DURATION_STR} (${TOTAL_SECONDS}s) — early exit detected" >> "$LOG_DIR/e-early-exits.log"

  # Stigmergic pressure: inject follow_up into engagement-trace.json
  python3 -c "
import json, os

trace_file = '$TRACE_FILE'
session = int('$SESSION')
duration = '$DURATION_STR'
total_s = int('$TOTAL_SECONDS')

try:
    with open(trace_file) as f:
        traces = json.load(f)
    if not isinstance(traces, list):
        traces = [traces] if isinstance(traces, dict) else []
except:
    traces = []

warning = f'EARLY EXIT WARNING: Previous E session (s{session}) exited in {duration} ({total_s}s). Ensure deeper engagement — check platform health first, then commit to full Phase 2 loop.'

if traces:
    latest = traces[-1]
    follow_ups = latest.get('follow_ups', [])
    follow_ups.append(warning)
    latest['follow_ups'] = follow_ups
    latest['early_exit_flag'] = True
else:
    traces.append({
        'session': session,
        'date': '$(date -I)',
        'early_exit_flag': True,
        'follow_ups': [warning],
        'note': f'Synthetic trace from early-exit hook. Session s{session} lasted {duration}.'
    })

with open(trace_file, 'w') as f:
    json.dump(traces, f, indent=2)
    f.write('\n')

print(f'early-exit: stigmergic pressure injected into trace for s{session}')
" 2>/dev/null || echo "early-exit: failed to inject stigmergic pressure (non-fatal)"
}

###############################################################################
# Check 4: Note fallback (was 39-note-fallback_E.sh)
#   Replaces truncated session-history notes with trace-derived summaries
###############################################################################
check_note_fallback() {
  [[ -f "$HISTORY_FILE" ]] || return
  [[ -f "$TRACE_FILE" ]] || return
  [[ -n "$CURRENT_NOTE" ]] || return

  # Check if note looks like a proper completion line
  if echo "$CURRENT_NOTE" | grep -qiE '^Session [A-Z]#[0-9]+.*complete'; then
    return  # Note is fine
  fi

  # Accept substantive notes (>60 chars with platform mentions)
  if [[ "${#CURRENT_NOTE}" -gt 60 ]] && echo "$CURRENT_NOTE" | grep -qiE 'engag|platform|chatr|moltbook|4claw|aicq|clawball|lobchan|pinchwork|colony'; then
    return  # Substantive enough
  fi

  # Note is truncated — generate from trace
  [[ "$HAS_TRACE" == "true" ]] || return

  GENERATED_NOTE=$(python3 -c "
import json, sys

parsed = json.load(open('$PARSED_FILE'))
session = int('$SESSION')
platforms = parsed.get('trace_platforms_engaged', [])
agents = parsed.get('trace_agents', [])
topics = parsed.get('trace_topics', [])
e_num = parsed.get('e_count', '?')

parts = []
if platforms:
    parts.append('Engaged ' + ', '.join(platforms))
if agents:
    parts.append('interacted with ' + ', '.join(agents[:3]))
if topics:
    parts.append(topics[0])

summary = '; '.join(parts) if parts else 'engagement session completed'
if len(summary) > 150:
    summary = summary[:147] + '...'

print(f'Session E#{e_num} (s{session}) complete. {summary}.')
" 2>/dev/null) || return

  [[ -n "$GENERATED_NOTE" ]] || return

  # Replace truncated note in session-history.txt
  GENERATED_NOTE="$GENERATED_NOTE" python3 << 'NOTEFALLBACK_PY' 2>/dev/null || echo "note-fallback: failed to rewrite history (non-fatal)"
import os

history_file = os.environ['HISTORY_FILE']
session_num = os.environ['SESSION']
new_note = os.environ['GENERATED_NOTE']

with open(history_file) as f:
    lines = f.readlines()

marker = f's={session_num} '
new_lines = []
for line in lines:
    if marker in line and 'note: ' in line:
        prefix = line[:line.index('note: ') + len('note: ')]
        new_lines.append(prefix + new_note + '\n')
    else:
        new_lines.append(line)

with open(history_file, 'w') as f:
    f.writelines(new_lines)

print(f'note-fallback: replaced truncated note for s{session_num}')
NOTEFALLBACK_PY
}

###############################################################################
# Check 5: Trace fallback (was 40-trace-fallback_E.sh)
#   Generates synthetic trace from intel when session truncated before Phase 3a
###############################################################################
check_trace_fallback() {
  [[ "$HAS_TRACE" == "true" ]] && return  # Trace exists, nothing to do

  [[ "$ARCHIVE_INTEL_COUNT" -gt 0 ]] || {
    echo "trace-fallback: s$SESSION has no intel entries, skipping"
    return
  }

  # Generate minimal trace from intel
  python3 -c "
import json, os, sys
from datetime import date

session = int('$SESSION')
trace_file = '$TRACE_FILE'
parsed = json.load(open('$PARSED_FILE'))
platforms = parsed.get('archive_intel_platforms', [])
topics = parsed.get('archive_intel_topics', [])

trace_entry = {
    'session': session,
    'date': str(date.today()),
    'picker_mandate': [],
    'platforms_engaged': platforms,
    'skipped_platforms': [],
    'topics': topics,
    'agents_interacted': [],
    'threads_contributed': [],
    'follow_ups': [],
    '_synthetic': True,
    '_source': 'trace-fallback (36-e-session-posthook_E.sh)',
    '_reason': f'Session s{session} truncated before Phase 3a trace write'
}

try:
    with open(trace_file) as f:
        traces = json.load(f)
    if not isinstance(traces, list):
        traces = [traces] if isinstance(traces, dict) else []
except:
    traces = []

traces.append(trace_entry)
if len(traces) > 30:
    traces = traces[-30:]

with open(trace_file, 'w') as f:
    json.dump(traces, f, indent=2)
    f.write('\n')

print(f'trace-fallback: generated synthetic trace for s{session} from {len(platforms)} platforms')
" 2>/dev/null || echo "trace-fallback: failed to generate synthetic trace (non-fatal)"
}

###############################################################################
# Check 6: Quality audit (was 41-quality-audit_E.sh)
#   Appends follow_up to trace when quality violations found
###############################################################################
check_quality_audit() {
  if [[ "$Q_TOTAL" -eq 0 ]]; then
    echo "quality-audit: s$SESSION had no quality-checked posts"
    return
  fi

  echo "quality-audit: s$SESSION — $Q_TOTAL posts checked, $Q_FAILS fails, $Q_WARNS warns"

  if [[ "$Q_FAILS" -gt 0 ]] && [[ -f "$TRACE_FILE" ]]; then
    python3 -c "
import json

session = int('$SESSION')
fail_count = int('$Q_FAILS')
total = int('$Q_TOTAL')
trace_file = '$TRACE_FILE'

try:
    with open(trace_file) as f:
        traces = json.load(f)
    if not isinstance(traces, list):
        traces = [traces] if isinstance(traces, dict) else []
except:
    traces = []

for trace in reversed(traces):
    if trace.get('session') == session:
        if 'follow_ups' not in trace:
            trace['follow_ups'] = []
        trace['follow_ups'].append({
            'type': 'quality_warning',
            'message': f's{session} quality gate: {fail_count}/{total} posts FAILED quality review. Review violations in quality-scores.jsonl and avoid repeating flagged patterns.',
            'severity': 'high' if fail_count > 1 else 'medium',
            'source': '36-e-session-posthook_E.sh'
        })
        break

with open(trace_file, 'w') as f:
    json.dump(traces, f, indent=2)
    f.write('\n')

print(f'quality-audit: appended follow_up to trace for s{session}')
" 2>/dev/null || echo "quality-audit: failed to append follow_up (non-fatal)"
  fi
}

###############################################################################
# Check 7: Quality enforcement (was 42-quality-enforce_E.sh)
#   Calculates rolling quality metrics and writes enforcement record
###############################################################################
check_quality_enforce() {
  if [[ ! -f "$QUALITY_SCORES" ]]; then
    echo "quality-enforce: no quality history, skipping"
    return
  fi

  node -e "
const fs = require('fs');
const lines = fs.readFileSync('$QUALITY_SCORES', 'utf8').trim().split('\n').filter(Boolean);
const entries = [];
for (const line of lines) {
  try { entries.push(JSON.parse(line)); } catch {}
}

if (entries.length === 0) {
  console.log('quality-enforce: no entries, skipping');
  process.exit(0);
}

const sessionEntries = entries.filter(e => e.session === $SESSION);
const sessionFails = sessionEntries.filter(e => e.verdict === 'FAIL').length;
const sessionTotal = sessionEntries.length;

const recent10 = entries.slice(-10);
const recentFails = recent10.filter(e => e.verdict === 'FAIL').length;
const recentFailRate = recentFails / recent10.length;

let streak = 0;
for (let i = entries.length - 1; i >= 0; i--) {
  if (entries[i].verdict === 'FAIL') streak++;
  else break;
}

const violFreq = {};
for (const e of recent10) {
  for (const v of (e.violations || [])) {
    violFreq[v] = (violFreq[v] || 0) + 1;
  }
}
const topViolation = Object.entries(violFreq).sort((a, b) => b[1] - a[1])[0];

const composites = recent10.map(e => e.composite).filter(c => typeof c === 'number');
const avgComposite = composites.length ? +(composites.reduce((a, b) => a + b, 0) / composites.length).toFixed(3) : null;

let level = 'ok';
let action = null;
if (recentFailRate > 0.6) {
  level = 'critical';
  action = 'Next E session: mandatory rewrite of any post scoring below 0.8. Consider pausing engagement until quality improves.';
} else if (recentFailRate > 0.4) {
  level = 'degraded';
  action = 'Next E session: extra scrutiny on formulaic patterns. Review top violation type.';
} else if (streak >= 3) {
  level = 'streak_warning';
  action = 'Consecutive failures detected. Break the pattern — try a different rhetorical approach.';
}

const record = {
  ts: new Date().toISOString(),
  session: $SESSION,
  session_posts: sessionTotal,
  session_fails: sessionFails,
  rolling_fail_rate: +recentFailRate.toFixed(3),
  rolling_avg_composite: avgComposite,
  fail_streak: streak,
  top_violation: topViolation ? topViolation[0] : null,
  level,
  action,
};

const enforceFile = '$ENFORCE_FILE';
const existingLines = fs.existsSync(enforceFile) ? fs.readFileSync(enforceFile, 'utf8').trim().split('\n').filter(Boolean) : [];
if (existingLines.length >= 50) existingLines.splice(0, existingLines.length - 49);
existingLines.push(JSON.stringify(record));
fs.writeFileSync(enforceFile, existingLines.join('\n') + '\n');

const statusIcon = level === 'ok' ? '✓' : level === 'degraded' ? '⚠' : level === 'critical' ? '✗' : '△';
console.log('quality-enforce: ' + statusIcon + ' s' + $SESSION + ' — ' + sessionTotal + ' posts (' + sessionFails + ' fails), rolling fail rate: ' + (recentFailRate * 100).toFixed(1) + '%, streak: ' + streak + ', level: ' + level);
if (action) console.log('quality-enforce: ACTION: ' + action);
" 2>/dev/null || echo "quality-enforce: script error (non-fatal)"
}

###############################################################################
# Check 8: E session cost cap (wq-719)
#   Warn when E session cost exceeds $2.50
#   Track 1-registration-per-session limit via trace keywords
###############################################################################
E_COST_THRESHOLD="2.50"

check_e_cost_cap() {
  # Extract cost from session-history.txt for this session
  local COST
  COST=$(grep "s=${SESSION} " "$HISTORY_FILE" 2>/dev/null | grep -oP 'cost=\$\K[0-9.]+' | tail -1 || echo "")

  if [[ -z "$COST" ]]; then
    echo "e-cost-cap: skip — no cost data yet for s${SESSION}"
    return
  fi

  # Compare cost to threshold (use node for float comparison)
  local OVER
  OVER=$(node -e "console.log(parseFloat('$COST') > parseFloat('$E_COST_THRESHOLD') ? 'yes' : 'no')" 2>/dev/null || echo "no")

  if [[ "$OVER" == "yes" ]]; then
    echo "e-cost-cap: WARN — s${SESSION} cost \$${COST} exceeds \$${E_COST_THRESHOLD} threshold"
    echo "WARN: E session s${SESSION} cost \$${COST} > \$${E_COST_THRESHOLD} cap" >> "$HOME/.config/moltbook/maintain-audit.txt" 2>/dev/null
  else
    echo "e-cost-cap: OK — s${SESSION} cost \$${COST} (threshold: \$${E_COST_THRESHOLD})"
  fi

  # Check registration count in trace
  if [[ "$HAS_TRACE" == "true" && -f "$TRACE_FILE" ]]; then
    local REG_COUNT
    REG_COUNT=$(node -e "
      const fs = require('fs');
      const traces = JSON.parse(fs.readFileSync('$TRACE_FILE', 'utf8'));
      const arr = Array.isArray(traces) ? traces : [traces];
      const t = arr.find(t => t.session === $SESSION);
      if (!t) { console.log(0); process.exit(0); }
      const text = JSON.stringify(t).toLowerCase();
      const keywords = ['register', 'signup', 'sign up', 'create account', 'new account', 'registration'];
      let count = 0;
      for (const kw of keywords) {
        const re = new RegExp(kw, 'gi');
        const matches = text.match(re);
        if (matches) count += matches.length;
      }
      // Normalize: count unique platform registrations, not keyword hits
      const platforms = t.platforms_engaged || [];
      const regPlatforms = platforms.filter(p => {
        const pText = JSON.stringify(t).toLowerCase();
        return keywords.some(kw => pText.includes(kw) && pText.includes(p.toLowerCase()));
      });
      console.log(Math.min(count > 0 ? Math.max(1, regPlatforms.length) : 0, 5));
    " 2>/dev/null || echo "0")

    if [[ "$REG_COUNT" -gt 1 ]]; then
      echo "e-cost-cap: WARN — s${SESSION} appears to have ${REG_COUNT} platform registrations (limit: 1)"
      echo "WARN: E session s${SESSION} had ${REG_COUNT} platform registrations (limit: 1)" >> "$HOME/.config/moltbook/maintain-audit.txt" 2>/dev/null
    elif [[ "$REG_COUNT" -eq 1 ]]; then
      echo "e-cost-cap: OK — 1 platform registration detected (within limit)"
    fi
  fi
}

###############################################################################
# Check 9: Covenant update (was 31-covenant-update_E.sh, wq-220)
#   Update covenant tracking from engagement trace after E session
###############################################################################
check_covenant_update() {
  cd "$MCP_DIR" || return 0
  node covenant-tracker.mjs update >/dev/null 2>&1 || true
}

###############################################################################
# Check 10: Scope bleed detection (was 37-scope-bleed-detect_E.sh, wq-712)
#   Warn if build commits were made during E session (scope violation)
###############################################################################
check_scope_bleed() {
  cd "$MCP_DIR" || return 0
  local RECENT_COMMITS
  RECENT_COMMITS=$(git log --oneline --since="15 minutes ago" 2>/dev/null | grep -cv "auto-snapshot" || true)
  if [ "$RECENT_COMMITS" -gt 0 ]; then
    local COMMIT_LIST
    COMMIT_LIST=$(git log --oneline --since="15 minutes ago" 2>/dev/null | grep -v "auto-snapshot" | head -5)
    echo "$(date -Iseconds) SCOPE-BLEED WARNING: E session s${SESSION} has ${RECENT_COMMITS} build commit(s):" >> "${LOG_DIR}/hooks.log"
    echo "$COMMIT_LIST" >> "${LOG_DIR}/hooks.log"
    echo "scope-bleed: WARN — E session s${SESSION} made ${RECENT_COMMITS} code commit(s)"
  fi
}

###############################################################################
# Phase 2: Run all checks sequentially
###############################################################################

check_intel_checkpoint
check_d049_enforcement
check_early_exit
check_note_fallback
check_trace_fallback
check_quality_audit
check_quality_enforce
check_e_cost_cap
check_covenant_update
check_scope_bleed

exit 0
