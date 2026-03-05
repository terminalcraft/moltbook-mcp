#!/bin/bash
# 33-stale-tag-check_A.sh — Detect queue items tagged with completed directives
# Created: B#529 (wq-828)
#
# Scans work-queue.json for non-done items whose tags reference directives
# that have status=completed in directives.json. Writes structured results
# to stale-tags-audit.json for audit report consumption.
#
# Non-blocking: stale tags are reported but don't prevent session start.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
OUTPUT_FILE="$STATE_DIR/stale-tags-audit.json"
DIRECTIVES_FILE="$DIR/directives.json"
QUEUE_FILE="$DIR/work-queue.json"

# Validate input files exist
if [ ! -f "$DIRECTIVES_FILE" ] || [ ! -f "$QUEUE_FILE" ]; then
  echo '{"checked":"'"$(date -Iseconds)"'","session":'"${SESSION_NUM:-0}"',"stale_count":0,"stale_items":[],"error":"missing directives.json or work-queue.json"}' > "$OUTPUT_FILE"
  echo "[stale-tags] ERROR: missing input files"
  exit 0
fi

# Use jq to cross-reference: find non-done queue items with tags matching completed directives
RESULT=$(jq -n \
  --slurpfile directives "$DIRECTIVES_FILE" \
  --slurpfile queue "$QUEUE_FILE" \
  --arg checked "$(date -Iseconds)" \
  --argjson session "${SESSION_NUM:-0}" \
  '
  # Extract completed directive IDs
  ($directives[0].directives | map(select(.status == "completed")) | map(.id)) as $completed_ids |

  # Find non-done queue items with directive-pattern tags that match completed directives
  [
    $queue[0].queue[] |
    select(.status != "done" and .status != "retired") |
    select((.tags // []) | length > 0) |
    . as $item |
    [.tags[] | select(test("^d[0-9]+$")) | select(. as $tag | $completed_ids | index($tag))] |
    select(length > 0) |
    {
      id: $item.id,
      title: $item.title,
      status: $item.status,
      stale_tags: .,
      all_tags: ($item.tags // [])
    }
  ] as $stale_items |

  {
    checked: $checked,
    session: $session,
    completed_directives_count: ($completed_ids | length),
    stale_count: ($stale_items | length),
    stale_items: $stale_items
  }
') || {
  echo '{"checked":"'"$(date -Iseconds)"'","session":'"${SESSION_NUM:-0}"',"stale_count":0,"stale_items":[],"error":"jq processing failed"}' > "$OUTPUT_FILE"
  echo "[stale-tags] ERROR: jq processing failed"
  exit 0
}

echo "$RESULT" > "$OUTPUT_FILE"

STALE_COUNT=$(echo "$RESULT" | jq '.stale_count')

if [ "$STALE_COUNT" -gt 0 ]; then
  ITEMS=$(echo "$RESULT" | jq -r '[.stale_items[] | "\(.id)(\(.stale_tags | join(",")))"] | join(", ")')
  echo "[stale-tags] $STALE_COUNT item(s) tagged with completed directives: $ITEMS"
  # Auto-remediate: remove stale tags from queue items (wq-835)
  node "$DIR/stale-tag-remediate.mjs" --apply 2>/dev/null && echo "[stale-tags] Auto-remediated stale tags" || echo "[stale-tags] WARN: auto-remediation failed"
else
  echo "[stale-tags] OK: no stale directive tags found"
fi

exit 0
