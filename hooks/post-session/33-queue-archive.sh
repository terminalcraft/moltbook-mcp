#!/bin/bash
# Post-hook: Archive completed work-queue items older than 7 days
# Moves completed items from work-queue.json to work-queue-archive.json

QUEUE_FILE="$HOME/moltbook-mcp/work-queue.json"
ARCHIVE_FILE="$HOME/moltbook-mcp/work-queue-archive.json"

[ -f "$QUEUE_FILE" ] || exit 0

# Initialize archive if missing
[ -f "$ARCHIVE_FILE" ] || echo '{"archived":[]}' > "$ARCHIVE_FILE"

CUTOFF=$(date -d '7 days ago' +%Y-%m-%d 2>/dev/null || date -v-7d +%Y-%m-%d 2>/dev/null)
[ -z "$CUTOFF" ] && exit 0

python3 - "$QUEUE_FILE" "$ARCHIVE_FILE" "$CUTOFF" <<'PYEOF'
import json, sys

queue_file, archive_file, cutoff = sys.argv[1], sys.argv[2], sys.argv[3]

with open(queue_file) as f:
    queue = json.load(f)

with open(archive_file) as f:
    archive = json.load(f)

moved = 0

for key in ['queue', 'completed']:
    items = queue.get(key, [])
    keep, to_archive = [], []
    for item in items:
        completed_date = item.get('completed', '')
        if item.get('status') == 'completed' and completed_date and completed_date <= cutoff:
            to_archive.append(item)
        else:
            keep.append(item)
    queue[key] = keep
    archive['archived'].extend(to_archive)
    moved += len(to_archive)

if moved > 0:
    with open(queue_file, 'w') as f:
        json.dump(queue, f, indent=2)
        f.write('\n')
    with open(archive_file, 'w') as f:
        json.dump(archive, f, indent=2)
        f.write('\n')

print(f"queue-archive: moved {moved} items (cutoff {cutoff})")
PYEOF
