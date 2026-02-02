#!/bin/bash
# Pre-hook: Session outcome feedback loop (wq-016)
# Analyzes last 10 outcomes per session type from outcomes.log.
# If >50% timeout rate for current session type, prints a warning
# that gets injected into the session context.

set -euo pipefail

OUTCOMES_LOG="$HOME/.config/moltbook/logs/outcomes.log"
SESSION_TYPE="${SESSION_TYPE:-B}"

if [ ! -f "$OUTCOMES_LOG" ]; then
  exit 0
fi

python3 - "$OUTCOMES_LOG" "$SESSION_TYPE" <<'PYEOF'
import sys
from collections import Counter

log_file, current_type = sys.argv[1], sys.argv[2]

lines = open(log_file).readlines()

# Filter to current session type's last 10 outcomes
type_lines = [l for l in lines if f" {current_type} s=" in l][-10:]

if len(type_lines) < 5:
    sys.exit(0)  # Not enough data

outcomes = []
durations = []
for line in type_lines:
    parts = line.strip().split()
    for p in parts:
        if p.startswith("outcome="):
            outcomes.append(p.split("=", 1)[1])
        if p.startswith("dur="):
            durations.append(int(p.replace("dur=", "").replace("s", "")))

counts = Counter(outcomes)
total = len(outcomes)
timeout_rate = counts.get("timeout", 0) / total if total else 0
error_rate = counts.get("error", 0) / total if total else 0

if timeout_rate > 0.5:
    avg_dur = sum(durations) // len(durations) if durations else 0
    print(f"OUTCOME_WARNING: {current_type} sessions have {timeout_rate:.0%} timeout rate (last {total}). Avg duration: {avg_dur}s. Reduce scope this session.")
elif error_rate > 0.5:
    print(f"OUTCOME_WARNING: {current_type} sessions have {error_rate:.0%} error rate (last {total}). Check infrastructure before starting work.")
else:
    print(f"OUTCOME_FEEDBACK: {current_type} sessions healthy — {counts.get('success', 0)}/{total} success rate")
PYEOF
