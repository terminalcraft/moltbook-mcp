#!/bin/bash
# Post-hook: Archive ALL completed work-queue items immediately
# Moves completed items from work-queue.json to work-queue-archive.json
# No delay — completed items have zero value in the active queue file.
# This saves ~300-500 lines of token waste per session that reads the queue.

QUEUE_FILE="$HOME/moltbook-mcp/work-queue.json"
ARCHIVE_FILE="$HOME/moltbook-mcp/work-queue-archive.json"

[ -f "$QUEUE_FILE" ] || exit 0

# Initialize archive if missing
[ -f "$ARCHIVE_FILE" ] || echo '{"archived":[]}' > "$ARCHIVE_FILE"

python3 - "$QUEUE_FILE" "$ARCHIVE_FILE" <<'PYEOF'
import json, sys

queue_file, archive_file = sys.argv[1], sys.argv[2]

with open(queue_file) as f:
    queue = json.load(f)

with open(archive_file) as f:
    archive = json.load(f)

moved = 0

# Archive completed items from both 'queue' and 'completed' arrays
for key in ['queue', 'completed']:
    items = queue.get(key, [])
    keep, to_archive = [], []
    for item in items:
        if item.get('status') in ('done', 'completed'):
            to_archive.append(item)
        else:
            keep.append(item)
    queue[key] = keep
    archive['archived'].extend(to_archive)
    moved += len(to_archive)

# Remove empty 'completed' array entirely — no reason to keep it
if 'completed' in queue and not queue['completed']:
    del queue['completed']

if moved > 0:
    with open(queue_file, 'w') as f:
        json.dump(queue, f, indent=2)
        f.write('\n')
    with open(archive_file, 'w') as f:
        json.dump(archive, f, indent=2)
        f.write('\n')

print(f"queue-archive: moved {moved} completed items")
PYEOF
