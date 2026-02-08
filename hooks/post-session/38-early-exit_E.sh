#!/bin/bash
# 38-early-exit_E.sh — Flag E sessions completing in <120s as anomalous (wq-423)
# and inject stigmergic pressure into engagement-trace.json (wq-428)
#
# E sessions averaging 3-5 minutes. Sessions under 2 minutes indicate
# early exit (platform errors, rate limits, truncation). Logs to a
# dedicated file for trend analysis by A sessions.
#
# STIGMERGIC PRESSURE (wq-428):
# When early exit detected, appends a follow_up to the latest trace entry
# in engagement-trace.json. Next E session reads recent traces in Phase 0
# and sees the warning, creating cross-session behavioral pressure without
# prompt modifications.
#
# Created: B#358 (wq-423)
# Enhanced: B#366 (wq-428) — stigmergic trace injection
set -euo pipefail

STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="$STATE_DIR/logs"
EARLY_EXIT_LOG="$LOG_DIR/e-early-exits.log"
TRACE_FILE="$STATE_DIR/engagement-trace.json"

: "${SESSION_NUM:?SESSION_NUM required}"
: "${MODE_CHAR:?MODE_CHAR required}"

# Parse duration from summary file
SUMMARY_FILE="${LOG_FILE%.log}.summary"
if [ ! -f "$SUMMARY_FILE" ]; then
  exit 0
fi

S_DUR=$(grep '^Duration:' "$SUMMARY_FILE" | head -1 | awk '{print $2}' | tr -d '~' || echo "0m0s")

# Convert XmYs to seconds
MINUTES=0
SECONDS_PART=0
if [[ "$S_DUR" =~ ^([0-9]+)m ]]; then
  MINUTES="${BASH_REMATCH[1]}"
fi
if [[ "$S_DUR" =~ ([0-9]+)s ]]; then
  SECONDS_PART="${BASH_REMATCH[1]}"
fi
TOTAL_SECONDS=$((MINUTES * 60 + SECONDS_PART))

# Threshold: 120 seconds (2 minutes)
if [ "$TOTAL_SECONDS" -lt 120 ]; then
  mkdir -p "$LOG_DIR"
  echo "$(date -Iseconds) s=$SESSION_NUM dur=${S_DUR} (${TOTAL_SECONDS}s) — early exit detected" >> "$EARLY_EXIT_LOG"

  # Stigmergic pressure: inject follow_up into engagement-trace.json (wq-428)
  python3 -c "
import json, os

trace_file = '$TRACE_FILE'
session = int('$SESSION_NUM')
duration = '$S_DUR'
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
    # Append warning to the latest trace's follow_ups
    latest = traces[-1]
    follow_ups = latest.get('follow_ups', [])
    follow_ups.append(warning)
    latest['follow_ups'] = follow_ups
    latest['early_exit_flag'] = True
else:
    # No trace exists — create a minimal entry with the warning
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
fi
