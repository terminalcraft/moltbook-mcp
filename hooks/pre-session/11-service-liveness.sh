#!/bin/bash
# Pre-session hook: Run service liveness check with caching.
# Updates services.json with liveness data.
# wq-547: Uses cache-wrapper.sh with 120-minute TTL to avoid redundant probes.
# wq-611: Increased interval from 10→20 sessions and TTL from 60→120 minutes
#          to reduce 9210ms avg startup cost.

SESSION_NUM="${SESSION_NUM:-0}"

# Only run every 20 sessions (wq-611: was 10, increased to reduce startup cost)
INTERVAL=20
if (( SESSION_NUM % INTERVAL != 0 )); then
  exit 0
fi

# Source caching wrapper
source "$(dirname "$0")/../lib/cache-wrapper.sh"

echo "[liveness] Running service liveness check (session $SESSION_NUM)..."
cd /home/moltbot/moltbook-mcp
cache_run "service-liveness" 120 node service-liveness.mjs --update
echo "[liveness] Done."
