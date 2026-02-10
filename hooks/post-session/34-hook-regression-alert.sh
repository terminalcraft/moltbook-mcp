#!/bin/bash
# 34-hook-regression-alert.sh — Post-session hook that detects per-hook timing regressions.
#
# Reads the latest entry from pre-hook-results.json and hook-results.json,
# compares each hook's execution time to its rolling 5-session average,
# and flags any hook that ran >2x its average.
#
# Outputs warnings to LOG_DIR/hook-regression-alerts.log and stderr.
# Exit 0 always (advisory only — never blocks session close).
#
# Created: B#417 (wq-557)

set -euo pipefail

LOG_DIR="${LOG_DIR:-$HOME/.config/moltbook/logs}"
ALERT_LOG="$LOG_DIR/hook-regression-alerts.log"
SESSION_NUM="${SESSION_NUM:-0}"
WINDOW=5
THRESHOLD=2.0

# Process one results file (JSONL)
check_regressions() {
  local results_file="$1"
  local phase="$2"

  [ -f "$results_file" ] || return 0

  local line_count
  line_count=$(wc -l < "$results_file" 2>/dev/null || echo 0)
  # Need at least WINDOW+1 entries (WINDOW for baseline + 1 for current)
  [ "$line_count" -ge $((WINDOW + 1)) ] || return 0

  # Extract last WINDOW+1 entries
  local entries
  entries=$(tail -n $((WINDOW + 1)) "$results_file")

  # Current session is the last line
  local current
  current=$(echo "$entries" | tail -1)

  # Baseline is the preceding WINDOW lines
  local baseline
  baseline=$(echo "$entries" | head -n "$WINDOW")

  # Get hook names and ms from current session
  # Format: {"hooks":[{"hook":"name","ms":123,"status":"ok"}, ...]}
  local current_hooks
  current_hooks=$(echo "$current" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for h in data.get('hooks', []):
    if h.get('status') in ('skip', 'budget_skip'):
        continue
    print(f\"{h['hook']}\t{h.get('ms', 0)}\")
" 2>/dev/null) || return 0

  # Build baseline averages
  local baseline_avgs
  baseline_avgs=$(echo "$baseline" | python3 -c "
import json, sys
from collections import defaultdict

totals = defaultdict(list)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        data = json.loads(line)
    except:
        continue
    for h in data.get('hooks', []):
        if h.get('status') in ('skip', 'budget_skip'):
            continue
        totals[h['hook']].append(h.get('ms', 0))

for hook, times in totals.items():
    avg = sum(times) / len(times) if times else 0
    print(f'{hook}\t{avg:.0f}\t{len(times)}')
" 2>/dev/null) || return 0

  # Compare current vs baseline
  local alerts=0
  while IFS=$'\t' read -r hook current_ms; do
    [ -z "$hook" ] && continue
    local baseline_avg baseline_count
    baseline_avg=$(echo "$baseline_avgs" | awk -F'\t' -v h="$hook" '$1==h {print $2}')
    baseline_count=$(echo "$baseline_avgs" | awk -F'\t' -v h="$hook" '$1==h {print $3}')

    # Skip hooks not in baseline or with too few samples
    [ -z "$baseline_avg" ] && continue
    [ -z "$baseline_count" ] && continue
    [ "$baseline_count" -lt 2 ] 2>/dev/null && continue

    # Skip if baseline average is very small (< 50ms) — noise threshold
    local avg_int=${baseline_avg%.*}
    [ "${avg_int:-0}" -lt 50 ] && continue

    # Check ratio
    local ratio
    ratio=$(python3 -c "
avg = $baseline_avg
cur = $current_ms
if avg > 0:
    print(f'{cur/avg:.1f}')
else:
    print('0.0')
" 2>/dev/null)

    # Compare ratio to threshold
    local exceeds
    exceeds=$(python3 -c "print('yes' if float('$ratio') >= $THRESHOLD else 'no')" 2>/dev/null)

    if [ "$exceeds" = "yes" ]; then
      local msg="[s${SESSION_NUM}] ${phase}/${hook}: ${current_ms}ms (${ratio}x avg ${baseline_avg}ms over ${baseline_count} sessions)"
      echo "REGRESSION: $msg" >&2
      echo "$(date -Iseconds) $msg" >> "$ALERT_LOG"
      alerts=$((alerts + 1))
    fi
  done <<< "$current_hooks"

  if [ "$alerts" -gt 0 ]; then
    echo "Hook regression: $alerts ${phase} hook(s) exceeded ${THRESHOLD}x their rolling average" >&2
  fi
}

# Run for both pre and post hook results
check_regressions "$LOG_DIR/pre-hook-results.json" "pre"
check_regressions "$LOG_DIR/hook-results.json" "post"

exit 0
