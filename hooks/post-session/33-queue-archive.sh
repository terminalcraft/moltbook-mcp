#!/bin/bash
# Post-hook: Archive completed AND retired work-queue items immediately
# Moves done/completed/retired items from work-queue.json to work-queue-archive.json
# No delay — finished items have zero value in the active queue file.
# This saves ~300-500 lines of token waste per session that reads the queue.
#
# Migrated from python3 to jq (wq-728, B#485)

QUEUE_FILE="$HOME/moltbook-mcp/work-queue.json"
ARCHIVE_FILE="$HOME/moltbook-mcp/work-queue-archive.json"

[ -f "$QUEUE_FILE" ] || exit 0

# Initialize archive if missing
[ -f "$ARCHIVE_FILE" ] || echo '{"archived":[]}' > "$ARCHIVE_FILE"

# Count archivable items first (avoid unnecessary writes)
ARCHIVABLE=$(jq '[(.queue // [])[], (.completed // [])[]] | map(select(.status == "done" or .status == "completed" or .status == "retired")) | length' "$QUEUE_FILE" 2>/dev/null || echo 0)

if [ "$ARCHIVABLE" -eq 0 ]; then
  echo "queue-archive: moved 0 completed/retired items"
  exit 0
fi

# Extract items to archive
TO_ARCHIVE=$(jq '[(.queue // [])[], (.completed // [])[]] | map(select(.status == "done" or .status == "completed" or .status == "retired"))' "$QUEUE_FILE")

# Update archive file: append new items
jq --argjson new "$TO_ARCHIVE" '.archived += $new' "$ARCHIVE_FILE" > "${ARCHIVE_FILE}.tmp" && mv "${ARCHIVE_FILE}.tmp" "$ARCHIVE_FILE"

# Update queue file: remove archived items, clean empty completed array
jq '
  .queue = [(.queue // [])[] | select(.status != "done" and .status != "completed" and .status != "retired")]
  | if (.completed // []) | length > 0 then
      .completed = [(.completed // [])[] | select(.status != "done" and .status != "completed" and .status != "retired")]
    else . end
  | if (.completed // []) | length == 0 then del(.completed) else . end
' "$QUEUE_FILE" > "${QUEUE_FILE}.tmp" && mv "${QUEUE_FILE}.tmp" "$QUEUE_FILE"

echo "queue-archive: moved $ARCHIVABLE completed/retired items"
