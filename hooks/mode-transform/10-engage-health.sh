#!/bin/bash
# Mode transform: E→B when engagement platforms are degraded
# Input: MODE_CHAR, env vars from heartbeat.sh
# Output: "NEW_MODE reason" or empty string
#
# Retry logic (added B#187): Single transient failures shouldn't block E sessions.
# We check twice with a 3-second gap — only convert if both checks fail.

[ "$MODE_CHAR" = "E" ] || exit 0

DIR="$(cd "$(dirname "$0")/../.." && pwd)"

check_health() {
  node "$DIR/engagement-health.cjs" 2>/dev/null | tail -1 || echo "ENGAGE_DEGRADED"
}

ENGAGE_STATUS=$(check_health)

if [ "$ENGAGE_STATUS" = "ENGAGE_DEGRADED" ]; then
  # First check failed — wait and retry to handle transient issues
  sleep 3
  ENGAGE_STATUS=$(check_health)

  if [ "$ENGAGE_STATUS" = "ENGAGE_DEGRADED" ]; then
    echo "B engagement platforms degraded (confirmed after retry)"
  fi
fi
