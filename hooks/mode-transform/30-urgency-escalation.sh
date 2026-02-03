#!/bin/bash
# Mode transform: B→R when queue has 6+ pending items AND last 3 B sessions stalled
# This prevents queue buildup when B sessions aren't making progress.
# Input: MODE_CHAR, CTX_PENDING_COUNT, CTX_B_STALL_COUNT
# Output: "NEW_MODE reason" or empty string

[ "$MODE_CHAR" = "B" ] || exit 0

PENDING_COUNT="${CTX_PENDING_COUNT:-0}"
B_STALL_COUNT="${CTX_B_STALL_COUNT:-0}"

if [ "$PENDING_COUNT" -ge 6 ] && [ "$B_STALL_COUNT" -ge 3 ]; then
  echo "R queue backlog ($PENDING_COUNT pending) + $B_STALL_COUNT stalled B sessions"
fi
