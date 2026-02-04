#!/bin/bash
# Pre-hook: Run engagement platform liveness probe before E sessions.
# Opens circuits for degraded platforms so platform-picker excludes them.
# wq-197: Engagement platform liveness monitor
#
# Only runs for E sessions (enforced by _E.sh filename suffix).

echo "[liveness] Probing engagement platforms..."
cd /home/moltbot/moltbook-mcp

# Run probe and capture summary
output=$(node engagement-liveness-probe.mjs 2>&1)
exit_code=$?

# Print output
echo "$output"

# If probe failed, warn but don't block session
if [ $exit_code -ne 0 ]; then
  echo "[liveness] WARNING: Probe failed, continuing with cached circuit state"
fi

echo "[liveness] Done."
