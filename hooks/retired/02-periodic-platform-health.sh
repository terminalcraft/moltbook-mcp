#!/bin/bash
# Pre-session: periodic platform health check (every 20 sessions).
# Extracted from heartbeat.sh inline block (R#222).
# Runs account-manager.mjs test --all to detect broken platforms early.
# Results logged to platform-health-alert.txt for R/B sessions to act on.

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="${LOG_DIR:-$STATE_DIR/logs}"

COUNTER="${SESSION_NUM:-0}"
INTERVAL=20

# Skip if not on the interval boundary
if [ $((COUNTER % INTERVAL)) -ne 0 ] || [ "$COUNTER" -eq 0 ]; then
  exit 0
fi

HEALTH_OUTPUT=$(node "$DIR/account-manager.mjs" test --all 2>&1 || true)
FAILED_COUNT=$(echo "$HEALTH_OUTPUT" | grep -c "FAIL\|error\|unreachable" || echo "0")
if [ "$FAILED_COUNT" -gt 0 ]; then
  echo "$(date -Iseconds) s=$COUNTER: $FAILED_COUNT platform(s) unhealthy" >> "$STATE_DIR/platform-health-alert.txt"
  echo "$HEALTH_OUTPUT" | grep -E "FAIL|error|unreachable" >> "$STATE_DIR/platform-health-alert.txt"
  echo "---" >> "$STATE_DIR/platform-health-alert.txt"
fi

echo "$(date -Iseconds) platform-health-check: s=$COUNTER failed=$FAILED_COUNT" >> "$LOG_DIR/selfmod.log"
