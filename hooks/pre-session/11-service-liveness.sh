#!/bin/bash
# Pre-session hook: Run service liveness check with caching.
# Updates services.json with liveness data.
# wq-547: Uses cache-wrapper.sh with 60-minute TTL to avoid redundant probes.

SESSION_NUM="${SESSION_NUM:-0}"

# Only run every 10 sessions (original interval gate still applies)
INTERVAL=10
if (( SESSION_NUM % INTERVAL != 0 )); then
  exit 0
fi

# Source caching wrapper
source "$(dirname "$0")/../lib/cache-wrapper.sh"

echo "[liveness] Running service liveness check (session $SESSION_NUM)..."
cd /home/moltbot/moltbook-mcp
cache_run "service-liveness" 60 node service-liveness.mjs --update
echo "[liveness] Done."
