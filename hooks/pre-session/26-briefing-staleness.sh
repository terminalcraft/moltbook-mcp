#!/bin/bash
# Pre-hook: BRIEFING.md auto-staleness detector (wq-011)
# Parses BRIEFING.md into sections by ## headers, checks a state file
# for when each section was last confirmed/updated. Flags sections
# stale for >50 sessions. Outputs warnings that get injected into
# session context.

set -euo pipefail

BRIEFING="$HOME/moltbook-mcp/BRIEFING.md"
STATE_DIR="$HOME/.config/moltbook"
STATE_FILE="$STATE_DIR/briefing-staleness.json"
SESSION_NUM="${SESSION_NUM:-0}"
STALE_THRESHOLD=50

mkdir -p "$STATE_DIR"

# Initialize state if missing
if [ ! -f "$STATE_FILE" ]; then
  echo '{}' > "$STATE_FILE"
fi

python3 - "$BRIEFING" "$STATE_FILE" "$SESSION_NUM" "$STALE_THRESHOLD" <<'PYEOF'
import json, sys, re
from pathlib import Path

briefing_file = sys.argv[1]
state_file = sys.argv[2]
session = int(sys.argv[3])
threshold = int(sys.argv[4])

if session == 0:
    sys.exit(0)

# Parse sections from BRIEFING.md
content = Path(briefing_file).read_text()
sections = []
current = None
for line in content.splitlines():
    m = re.match(r'^##\s+(.+)$', line)
    if m:
        current = m.group(1).strip()
        sections.append(current)

if not sections:
    print("BRIEFING_STALE: No sections found")
    sys.exit(0)

# Load state
state = json.loads(Path(state_file).read_text())

# Initialize any new sections at current session
changed = False
for sec in sections:
    if sec not in state:
        state[sec] = {"last_updated": session}
        changed = True

# Remove sections no longer in BRIEFING.md
for key in list(state.keys()):
    if key not in sections:
        del state[key]
        changed = True

if changed:
    Path(state_file).write_text(json.dumps(state, indent=2) + "\n")

# Check staleness
stale = []
for sec in sections:
    last = state[sec].get("last_updated", 0)
    age = session - last
    if age >= threshold:
        stale.append((sec, age))

if stale:
    print(f"BRIEFING_STALE: {len(stale)} section(s) need review:")
    for sec, age in stale:
        print(f"  - \"{sec}\" — {age} sessions since last update")
else:
    print(f"BRIEFING_STALE: All {len(sections)} sections fresh (threshold: {threshold})")
PYEOF
