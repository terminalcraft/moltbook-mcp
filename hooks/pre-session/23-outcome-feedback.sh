#!/bin/bash
# Pre-hook: Session outcome feedback + rotation tuning pipeline
#
# Phase 1: Analyzes last 10 outcomes per session type from outcomes.log.
#           Prints warnings if timeout/error rate exceeds 50%.
# Phase 2: Runs rotation-tuner.py to evaluate rotation efficiency and
#           writes recommendation to rotation-tuning.json. On R sessions,
#           if a rotation change is recommended, auto-applies it.
#
# Originally: wq-016 (outcome feedback only)
# Restructured R#100: integrated rotation-tuner into live pipeline.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTCOMES_LOG="$HOME/.config/moltbook/logs/outcomes.log"
SESSION_TYPE="${MODE_CHAR:-B}"
STATE_DIR="$HOME/.config/moltbook"
TUNING_STATE="$STATE_DIR/rotation-tuning.json"

# ── Phase 1: Outcome health check ──

if [ -f "$OUTCOMES_LOG" ]; then
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
fi

# ── Phase 2: Rotation tuning ──

TUNER="$DIR/rotation-tuner.py"
if [ ! -f "$TUNER" ]; then
  exit 0
fi

# Run tuner in JSON mode and capture output
TUNER_OUTPUT=$(python3 "$TUNER" --json 2>/dev/null) || exit 0

# Write tuning state for session consumption
echo "$TUNER_OUTPUT" > "$TUNING_STATE"

# Extract recommendation
CHANGED=$(echo "$TUNER_OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['recommendation']['changed'])" 2>/dev/null) || exit 0
NEW_PATTERN=$(echo "$TUNER_OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['recommendation']['pattern'])" 2>/dev/null) || exit 0
REASON=$(echo "$TUNER_OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['recommendation']['reason'])" 2>/dev/null) || exit 0
CURRENT=$(echo "$TUNER_OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['recommendation']['current'])" 2>/dev/null) || exit 0

if [ "$CHANGED" = "True" ]; then
  if [ "$SESSION_TYPE" = "R" ]; then
    # R sessions auto-apply rotation changes — they own self-evolution
    python3 "$TUNER" --apply > /dev/null 2>&1
    echo "ROTATION_TUNED: Applied $CURRENT → $NEW_PATTERN ($REASON)"
    echo "$(date -Iseconds) rotation-tuner auto-applied: $CURRENT → $NEW_PATTERN ($REASON)" >> "$HOME/.config/moltbook/logs/selfmod.log"
  else
    # Non-R sessions: surface as advisory
    echo "ROTATION_ADVISORY: Tuner recommends $CURRENT → $NEW_PATTERN ($REASON). Will auto-apply next R session."
  fi
else
  echo "ROTATION_STATUS: $CURRENT optimal — no change needed"
fi
