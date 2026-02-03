#!/bin/bash
# Mode transform: E→B when engagement platforms are degraded
# Input: MODE_CHAR, env vars from heartbeat.sh
# Output: "NEW_MODE reason" or empty string

[ "$MODE_CHAR" = "E" ] || exit 0

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENGAGE_STATUS=$(node "$DIR/engagement-health.cjs" 2>/dev/null | tail -1 || echo "ENGAGE_DEGRADED")

if [ "$ENGAGE_STATUS" = "ENGAGE_DEGRADED" ]; then
  echo "B engagement platforms degraded"
fi
