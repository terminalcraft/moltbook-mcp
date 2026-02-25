#!/bin/bash
# Pre-hook: Stale pending item detector (wq-651)
# Flags pending work-queue items with 0 commits that have been pending
# for >15 sessions. Outputs warnings to stdout (picked up by session log).
# Does NOT auto-escalate — just surfaces staleness for the session to act on.

set -euo pipefail

QUEUE="$HOME/moltbook-mcp/work-queue.json"
STATE_DIR="$HOME/.config/moltbook"
STALE_STATE="$STATE_DIR/pending-tracking.json"
SESSION_NUM="${SESSION_NUM:-0}"
STALE_THRESHOLD=15

mkdir -p "$STATE_DIR"

if [ ! -f "$STALE_STATE" ]; then
  echo '{}' > "$STALE_STATE"
fi

if [ "$SESSION_NUM" -eq 0 ]; then
  exit 0
fi

python3 - "$QUEUE" "$STALE_STATE" "$SESSION_NUM" "$STALE_THRESHOLD" <<'PYEOF'
import json, sys
from pathlib import Path

queue_file, state_file = sys.argv[1], sys.argv[2]
session = int(sys.argv[3])
threshold = int(sys.argv[4])

queue = json.loads(Path(queue_file).read_text())
state = json.loads(Path(state_file).read_text())
items = queue.get("queue", [])

pending = [i for i in items if i.get("status") == "pending"]
stale = []

for item in pending:
    wid = item["id"]
    commits = len(item.get("commits") or [])

    # Track first time we see this item as pending
    if wid not in state:
        state[wid] = {"first_seen": session}
        continue

    first_seen = state[wid]["first_seen"]
    age = session - first_seen

    if age >= threshold and commits == 0:
        stale.append({
            "id": wid,
            "title": item.get("title", "")[:60],
            "age": age,
        })

# Clean up tracking for items no longer pending
active_pending_ids = {i["id"] for i in pending}
for wid in list(state.keys()):
    if wid not in active_pending_ids:
        del state[wid]

Path(state_file).write_text(json.dumps(state, indent=2) + "\n")

if stale:
    print(f"STALE_PENDING: {len(stale)} items pending >{threshold} sessions with no commits:")
    for s in stale:
        print(f"  - {s['id']}: {s['title']} ({s['age']} sessions)")
else:
    print(f"STALE_PENDING: {len(pending)} pending items, none stale")
PYEOF
