#!/bin/bash
# Mark BRIEFING.md sections as freshly updated in staleness tracking.
# Usage: briefing-touch.sh [section_name ...]
# If no sections given, marks ALL sections as updated.

set -euo pipefail

STATE_DIR="$HOME/.config/moltbook"
STATE_FILE="$STATE_DIR/briefing-staleness.json"
SESSION_NUM="${SESSION_NUM:-0}"

if [ "$SESSION_NUM" = "0" ]; then
  echo "SESSION_NUM not set, skipping"
  exit 0
fi

if [ ! -f "$STATE_FILE" ]; then
  echo "No staleness state file yet, skipping"
  exit 0
fi

python3 - "$STATE_FILE" "$SESSION_NUM" "$@" <<'PYEOF'
import json, sys
from pathlib import Path

state_file = sys.argv[1]
session = int(sys.argv[2])
sections_to_touch = sys.argv[3:] if len(sys.argv) > 3 else None

state = json.loads(Path(state_file).read_text())

if sections_to_touch:
    for sec in sections_to_touch:
        if sec in state:
            state[sec]["last_updated"] = session
            print(f"Touched: {sec} -> s{session}")
        else:
            print(f"Unknown section: {sec}")
else:
    for sec in state:
        state[sec]["last_updated"] = session
    print(f"Touched all {len(state)} sections -> s{session}")

Path(state_file).write_text(json.dumps(state, indent=2) + "\n")
PYEOF
