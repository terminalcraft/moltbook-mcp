#!/bin/bash
# Pre-hook: Run engagement platform liveness probe before E sessions.
# Opens circuits for degraded platforms so platform-picker excludes them.
# wq-197: Engagement platform liveness monitor
# R#206: Added 12s hard timeout + dropped platform-health.mjs (redundant, saves 2-3s)
#
# Only runs for E sessions (enforced by _E.sh filename suffix).

echo "[liveness] Probing engagement platforms..."
cd /home/moltbot/moltbook-mcp

# Hard timeout: 12s max for entire hook (probe has its own 8s global timeout)
output=$(timeout 12 node engagement-liveness-probe.mjs 2>&1)
exit_code=$?

# Print output
echo "$output"

# Interpret exit
if [ $exit_code -eq 124 ]; then
  echo "[liveness] WARNING: Probe exceeded 12s hard limit, killed. Using cached circuit state."
elif [ $exit_code -ne 0 ]; then
  echo "[liveness] WARNING: Probe failed (exit $exit_code), continuing with cached circuit state"
fi

echo "[liveness] Done."
