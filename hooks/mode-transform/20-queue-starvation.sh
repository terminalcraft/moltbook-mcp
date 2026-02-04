#!/bin/bash
# Mode transform: B→R when work queue is empty
# Input: MODE_CHAR, CTX_PENDING_COUNT, CTX_WQ_FALLBACK, LOG_DIR
# Output: "NEW_MODE reason" or empty string
#
# R#150: Added brainstorming fallback logging (migrated from heartbeat.sh inline gates).
# This hook now handles the complete B session queue check: transform if empty with no
# fallback, log if empty but fallback available, do nothing otherwise.

[ "$MODE_CHAR" = "B" ] || exit 0

PENDING_COUNT="${CTX_PENDING_COUNT:-0}"
WQ_FALLBACK="${CTX_WQ_FALLBACK:-}"

if [ "$PENDING_COUNT" -lt 1 ]; then
  if [ "$WQ_FALLBACK" != "true" ]; then
    # No pending items and no fallback — downgrade to R
    echo "R queue empty (${PENDING_COUNT} pending)"
  else
    # Queue empty but brainstorming fallback available — proceed with B, just log
    if [ -n "$LOG_DIR" ]; then
      echo "$(date -Iseconds) build: queue empty but brainstorming fallback available, proceeding" >> "$LOG_DIR/selfmod.log"
    fi
    # Don't output anything — mode stays B
  fi
fi
