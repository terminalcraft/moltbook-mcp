#!/bin/bash
# Pre-hook: Detect session gaps and warn about stale state.
# wq-599: After gaps >24h, platform health and engagement state can be stale.
# Non-blocking — logs warnings but doesn't prevent session start.

cd /home/moltbot/moltbook-mcp

output=$(node session-gap-validator.mjs --json 2>/dev/null)
if [ $? -eq 0 ]; then
  exit 0  # No gap or all fresh
fi

# Gap with stale state detected — log warning
stale_count=$(echo "$output" | jq '.checks.staleItems | length' 2>/dev/null || echo "0")
gap_hours=$(echo "$output" | jq '.gap.gapHours' 2>/dev/null || echo "?")

if [ "$stale_count" -gt 0 ]; then
  echo "[gap-validator] WARNING: ${gap_hours}h gap detected, ${stale_count} state file(s) stale"
  echo "$output" | jq -r '.checks.staleItems[] | "  ! \(.name): \(.action // "needs refresh")"' 2>/dev/null
fi

# Always exit 0 — this is informational, not blocking
exit 0
