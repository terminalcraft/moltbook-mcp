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

# wq-705: Replaced python3 with jq for JSON parsing

if [ "$SESSION_NUM" -eq 0 ]; then
  exit 0
fi

# Phase 1: Update blocker tracking state and identify nudge candidates
TMP_STATE=$(mktemp)
TMP_NUDGES=$(mktemp)

jq --argjson session "$SESSION_NUM" --argjson threshold "$STALE_THRESHOLD" \
   --argjson re_escalate "$RE_ESCALATE_INTERVAL" \
   --slurpfile queue "$QUEUE" '
  . as $state |
  # R#191: Filter out items with "deferred" tag
  [$queue[0].queue[] | select(.status == "blocked" and ((.tags // []) | index("deferred") | not))] as $blocked |
  [$blocked[].id] as $blocked_ids |

  # Process each blocked item
  reduce $blocked[] as $item ($state;
    if (.[$item.id].first_seen_blocked // null) == null then
      . + {($item.id): {"first_seen_blocked": $session, "last_escalated": 0}}
    else . end
  ) |

  # Remove entries for items no longer blocked
  with_entries(select(.key as $k | $blocked_ids | index($k)))
' "$BLOCKER_STATE" > "$TMP_STATE"

# Extract nudge candidates (stale enough to escalate)
jq -r --argjson session "$SESSION_NUM" --argjson threshold "$STALE_THRESHOLD" \
   --argjson re_escalate "$RE_ESCALATE_INTERVAL" \
   --slurpfile queue "$QUEUE" '
  . as $state |
  [$queue[0].queue[] | select(.status == "blocked" and ((.tags // []) | index("deferred") | not))] as $blocked |
  [
    $blocked[] |
    ($state[.id] // {}) as $entry |
    select(
      $entry.first_seen_blocked != null and
      ($session - $entry.first_seen_blocked) >= $threshold and
      ($entry.last_escalated == 0 or ($session - $entry.last_escalated) >= $re_escalate)
    ) |
    {id, title: (.title // ""), blocker: (.blocker // ""), age: ($session - $entry.first_seen_blocked)}
  ] | tojson
' "$TMP_STATE" > "$TMP_NUDGES"

NUDGES=$(cat "$TMP_NUDGES")
NUDGE_COUNT=$(echo "$NUDGES" | jq 'length' 2>/dev/null || echo 0)

# Update last_escalated for nudged items
if [ "$NUDGE_COUNT" -gt 0 ]; then
  NUDGE_IDS=$(echo "$NUDGES" | jq -r '.[].id')
  for nid in $NUDGE_IDS; do
    jq --arg id "$nid" --argjson session "$SESSION_NUM" \
      '.[$id].last_escalated = $session' "$TMP_STATE" > "${TMP_STATE}.tmp" && mv "${TMP_STATE}.tmp" "$TMP_STATE"
  done
fi

mv "$TMP_STATE" "$BLOCKER_STATE"

# Phase 2: Create directive if nudges exist
BLOCKED_COUNT=$(jq --slurpfile queue "$QUEUE" \
  '[$queue[0].queue[] | select(.status == "blocked" and ((.tags // []) | index("deferred") | not))] | length' \
  "$BLOCKER_STATE" 2>/dev/null || echo 0)

if [ "$NUDGE_COUNT" -gt 0 ]; then
  ITEMS_LIST=$(echo "$NUDGES" | jq -r '[.[] | "\(.id) (\(.title[:50]), blocked \(.age)s, blocker: \(.blocker[:60]))"] | join(", ")')
  CONTENT="Auto-escalation: ${NUDGE_COUNT} work queue items blocked >${STALE_THRESHOLD} sessions: ${ITEMS_LIST}. Human action may be needed."
  MAX_ID=$(jq '[.directives[]?.id // "" | ltrimstr("d") | tonumber] | max // 0' "$DIRECTIVES" 2>/dev/null || echo 0)
  NEW_NUM=$((MAX_ID + 1))
  NEW_ID=$(printf "d%03d" "$NEW_NUM")
  CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  TMP_DIR=$(mktemp)
  jq --arg id "$NEW_ID" --argjson session "$SESSION_NUM" --arg content "$CONTENT" --arg created "$CREATED" '
    .directives += [{id: $id, from: "system", session: $session, content: $content, status: "pending", created: $created}]
  ' "$DIRECTIVES" > "$TMP_DIR" && mv "$TMP_DIR" "$DIRECTIVES"

  echo "STALE_BLOCKER: Escalated ${NUDGE_COUNT} blocked items as directive ${NEW_ID}"
else
  echo "STALE_BLOCKER: ${BLOCKED_COUNT} blocked items, none stale enough to escalate"
fi

rm -f "$TMP_NUDGES"
