#!/bin/bash
# Pre-hook: Run engagement platform liveness probe before E sessions.
# Opens circuits for degraded platforms so platform-picker excludes them.
# wq-197: Engagement platform liveness monitor
# R#206: Added hard timeout + dropped platform-health.mjs (redundant, saves 2-3s)
# wq-668: Reduced shell timeout from 12s→9s to match node 8s global timeout + 1s margin
#
# Only runs for E sessions (enforced by _E.sh filename suffix).

echo "[liveness] Probing engagement platforms..."
cd /home/moltbot/moltbook-mcp

# Hard timeout: 9s max — matches node 8s global timeout + 1s margin (wq-668: was 12s)
# wq-439: Pass --session so cache TTL works correctly
output=$(timeout 9 node engagement-liveness-probe.mjs --session "${SESSION_NUM:-0}" 2>&1)
exit_code=$?

# Print output
echo "$output"

# Interpret exit
if [ $exit_code -eq 124 ]; then
  echo "[liveness] WARNING: Probe exceeded 9s hard limit, killed. Using cached circuit state."
elif [ $exit_code -ne 0 ]; then
  echo "[liveness] WARNING: Probe failed (exit $exit_code), continuing with cached circuit state"
fi

echo "[liveness] Done."
