#!/bin/bash
# Pre-hook: Stale blocker auto-escalation (wq-011)
# Checks blocked work-queue items. If blocked >30 sessions, creates
# a directive in directives.json. Tracks first-seen-blocked session and
# last-escalated session to avoid spam (re-escalates every 50 sessions).

set -euo pipefail

STATE_DIR="$HOME/.config/moltbook"
BLOCKER_STATE="$STATE_DIR/blocker-tracking.json"
QUEUE="$HOME/moltbook-mcp/work-queue.json"
DIRECTIVES="$HOME/moltbook-mcp/directives.json"
SESSION_NUM="${SESSION_NUM:-0}"
STALE_THRESHOLD=30
RE_ESCALATE_INTERVAL=50

mkdir -p "$STATE_DIR"

# Initialize state if missing
if [ ! -f "$BLOCKER_STATE" ]; then
  echo '{}' > "$BLOCKER_STATE"
fi

python3 - "$QUEUE" "$BLOCKER_STATE" "$DIRECTIVES" "$SESSION_NUM" "$STALE_THRESHOLD" "$RE_ESCALATE_INTERVAL" <<'PYEOF'
import json, sys
from pathlib import Path

queue_file, state_file, directives_file = sys.argv[1], sys.argv[2], sys.argv[3]
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

    if last_esc > 0 and (session - last_esc) < re_escalate:
        continue

    nudges.append({
        "id": wid,
        "title": item.get("title", ""),
        "blocker": item.get("blocker", ""),
        "age": age
    })
    state[wid]["last_escalated"] = session

active_blocked_ids = {i["id"] for i in blocked}
for wid in list(state.keys()):
    if wid not in active_blocked_ids:
        del state[wid]

Path(state_file).write_text(json.dumps(state, indent=2) + "\n")

# Add escalation as a directive in directives.json
if nudges:
    directives = json.loads(Path(directives_file).read_text())
    items_list = ", ".join(f"{n['id']} ({n['title'][:50]}, blocked {n['age']}s, blocker: {n['blocker'][:60]})" for n in nudges)
    content = f"Auto-escalation: {len(nudges)} work queue items blocked >{threshold} sessions: {items_list}. Human action may be needed."
    max_id = max((int(d["id"].replace("d", "")) for d in directives.get("directives", [])), default=0)
    new_id = f"d{max_id + 1:03d}"
    directives.setdefault("directives", []).append({
        "id": new_id,
        "from": "system",
        "session": session,
        "content": content,
        "status": "pending",
        "created": f"{__import__('datetime').datetime.utcnow().isoformat()}Z"
    })
    Path(directives_file).write_text(json.dumps(directives, indent=2) + "\n")
    print(f"STALE_BLOCKER: Escalated {len(nudges)} blocked items as directive {new_id}")
else:
    print(f"STALE_BLOCKER: {len(blocked)} blocked items, none stale enough to escalate")
PYEOF
