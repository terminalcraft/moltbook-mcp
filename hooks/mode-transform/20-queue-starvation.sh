#!/bin/bash
# Mode transform: B→R when work queue is empty
# Input: MODE_CHAR, CTX_PENDING_COUNT, CTX_WQ_FALLBACK
# Output: "NEW_MODE reason" or empty string

[ "$MODE_CHAR" = "B" ] || exit 0

PENDING_COUNT="${CTX_PENDING_COUNT:-0}"
WQ_FALLBACK="${CTX_WQ_FALLBACK:-}"

if [ "$PENDING_COUNT" -lt 1 ] && [ "$WQ_FALLBACK" != "true" ]; then
  echo "R queue empty (${PENDING_COUNT} pending)"
fi
