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

# wq-705: Replaced python3 with jq for JSON parsing

# Get pending item IDs from queue
PENDING_IDS=$(jq -r '[.queue[] | select(.status == "pending") | .id] | .[]' "$QUEUE" 2>/dev/null)
PENDING_COUNT=$(echo "$PENDING_IDS" | grep -c . 2>/dev/null || echo 0)

# Update state: add new pending items, remove non-pending
TMP_STATE=$(mktemp)
jq --argjson session "$SESSION_NUM" --argjson threshold "$STALE_THRESHOLD" \
  --slurpfile queue "$QUEUE" '
  . as $state |
  [$queue[0].queue[] | select(.status == "pending")] as $pending |
  [$pending[].id] as $pending_ids |

  # Add new items not yet tracked
  reduce $pending[] as $item ($state;
    if has($item.id) then . else . + {($item.id): {"first_seen": $session}} end
  ) |

  # Remove items no longer pending
  with_entries(select(.key as $k | $pending_ids | index($k)))
' "$STALE_STATE" > "$TMP_STATE" && mv "$TMP_STATE" "$STALE_STATE"

# Find stale items and report
STALE_OUTPUT=$(jq -r --argjson session "$SESSION_NUM" --argjson threshold "$STALE_THRESHOLD" \
  --slurpfile queue "$QUEUE" '
  . as $state |
  [$queue[0].queue[] | select(.status == "pending")] as $pending |
  [
    $pending[] |
    select(
      (.commits // [] | length) == 0 and
      $state[.id].first_seen != null and
      ($session - $state[.id].first_seen) >= $threshold
    ) |
    "  - \(.id): \(.title[:60]) (\($session - $state[.id].first_seen) sessions)"
  ] |
  if length > 0 then
    "STALE_PENDING: \(length) items pending >\($threshold) sessions with no commits:\n" + join("\n")
  else
    "STALE_PENDING: \($pending | length) pending items, none stale"
  end
' "$STALE_STATE" 2>/dev/null)

echo -e "$STALE_OUTPUT"
