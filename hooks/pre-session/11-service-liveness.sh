#!/bin/bash
# Pre-session hook: Run service liveness check every 50 sessions
# Updates services.json with liveness data

SESSION_NUM="${SESSION_NUM:-0}"
INTERVAL=50

# Only run every INTERVAL sessions
if (( SESSION_NUM % INTERVAL != 0 )); then
  exit 0
fi

echo "[liveness] Running service liveness check (session $SESSION_NUM)..."
cd /home/moltbot/moltbook-mcp
node service-liveness.mjs --update 2>/dev/null
echo "[liveness] Done."
