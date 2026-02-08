#!/bin/bash
# Pre-session: restart API if api.mjs is newer than the running process
# This prevents stale-code smoke test failures (wq-445)
API_PID=$(pgrep -f "node.*api\.mjs" 2>/dev/null | head -1)
if [ -z "$API_PID" ]; then
  # API not running — start it
  sudo systemctl start molty-api.service 2>/dev/null
  exit 0
fi

# Compare api.mjs mtime to process start time
API_FILE="/home/moltbot/moltbook-mcp/api.mjs"
FILE_MTIME=$(stat -c %Y "$API_FILE" 2>/dev/null || echo 0)
PROC_START=$(stat -c %Y "/proc/$API_PID" 2>/dev/null || echo 0)

if [ "$FILE_MTIME" -gt "$PROC_START" ]; then
  sudo systemctl restart molty-api.service 2>/dev/null
  sleep 2
  echo "$(date -Iseconds) API restarted (api.mjs newer than running process)" >> "$HOME/.config/moltbook/logs/api-restart.log"
fi
