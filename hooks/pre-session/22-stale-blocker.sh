#!/bin/bash
# Pre-hook: Stale blocker auto-escalation (wq-011)
# Checks blocked work-queue items. If blocked >30 sessions, appends
# a nudge to dialogue.md. Tracks first-seen-blocked session and
# last-escalated session to avoid spam (re-escalates every 50 sessions).

set -euo pipefail

STATE_DIR="$HOME/.config/moltbook"
BLOCKER_STATE="$STATE_DIR/blocker-tracking.json"
QUEUE="$HOME/moltbook-mcp/work-queue.json"
DIALOGUE="$HOME/moltbook-mcp/dialogue.md"
SESSION_NUM="${SESSION_NUM:-0}"
STALE_THRESHOLD=30
RE_ESCALATE_INTERVAL=50

mkdir -p "$STATE_DIR"

# Initialize state if missing
if [ ! -f "$BLOCKER_STATE" ]; then
  echo '{}' > "$BLOCKER_STATE"
fi

python3 - "$QUEUE" "$BLOCKER_STATE" "$DIALOGUE" "$SESSION_NUM" "$STALE_THRESHOLD" "$RE_ESCALATE_INTERVAL" <<'PYEOF'
import json, sys
from pathlib import Path

queue_file, state_file, dialogue_file = sys.argv[1], sys.argv[2], sys.argv[3]
session = int(sys.argv[4])
threshold = int(sys.argv[5])
re_escalate = int(sys.argv[6])

if session == 0:
    sys.exit(0)

queue = json.loads(Path(queue_file).read_text())
state = json.loads(Path(state_file).read_text())
items = queue.get("queue", [])

blocked = [i for i in items if i.get("status") == "blocked"]
nudges = []

for item in blocked:
    wid = item["id"]
    entry = state.get(wid, {})

    if not entry.get("first_seen_blocked"):
        # First time seeing this item blocked — record it
        state[wid] = {
            "first_seen_blocked": session,
            "last_escalated": 0
        }
        continue

    first_seen = entry["first_seen_blocked"]
    last_esc = entry.get("last_escalated", 0)
    age = session - first_seen

    if age < threshold:
        continue

    # Check cooldown
    if last_esc > 0 and (session - last_esc) < re_escalate:
        continue

    # Escalate
    nudges.append({
        "id": wid,
        "title": item.get("title", ""),
        "blocker": item.get("blocker", ""),
        "age": age
    })
    state[wid]["last_escalated"] = session

# Clean up state for items no longer blocked
active_blocked_ids = {i["id"] for i in blocked}
for wid in list(state.keys()):
    if wid not in active_blocked_ids:
        del state[wid]

# Write state
Path(state_file).write_text(json.dumps(state, indent=2) + "\n")

# Append nudges to dialogue.md
if nudges:
    lines = [f"\n### Auto-escalation (s{session}):\n"]
    lines.append(f"The following work queue items have been blocked for **>{threshold} sessions** with no resolution:\n")
    for n in nudges:
        lines.append(f"- **{n['id']}** ({n['title']}): blocked {n['age']} sessions. Blocker: {n['blocker']}")
    lines.append("")
    lines.append("Human action may be needed to unblock these. Please review or drop them from the queue.\n")

    with open(dialogue_file, "a") as f:
        f.write("\n".join(lines))

    print(f"STALE_BLOCKER: Escalated {len(nudges)} blocked items to dialogue.md")
else:
    print(f"STALE_BLOCKER: {len(blocked)} blocked items, none stale enough to escalate")
PYEOF
