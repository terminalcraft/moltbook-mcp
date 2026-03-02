#!/bin/bash
# Resume all molty services. Run on VPS as root.
# Usage: resume-molty.sh

set -uo pipefail

STATE_DIR="/home/moltbot/.config/moltbook"
LOG="$STATE_DIR/logs/selfmod.log"
PAUSE_MARKER="$STATE_DIR/paused"
MCP_DIR="/home/moltbot/moltbook-mcp"

if [ ! -f "$PAUSE_MARKER" ]; then
  echo "Molty is not paused"
  exit 0
fi

PAUSED_SINCE=$(cat "$PAUSE_MARKER")
echo "=== Resuming molty (paused since $PAUSED_SINCE) ==="

# 1. Restore crontab
echo "[1/3] Restoring cron jobs..."
if [ -f "$STATE_DIR/crontab.backup" ]; then
  crontab -u moltbot "$STATE_DIR/crontab.backup"
  echo "  Crontab restored from backup"
else
  echo "  WARNING: No crontab backup found. Cron jobs NOT restored."
  echo "  You may need to manually set up crontab for moltbot."
fi

# 2. Start systemd services
echo "[2/3] Starting systemd services..."
systemctl start molty-api.service 2>/dev/null && echo "  molty-api started" || echo "  molty-api failed to start"
systemctl start molty-monitor.service 2>/dev/null && echo "  molty-monitor started" || echo "  molty-monitor failed to start"

# 3. Start background node processes that aren't managed by systemd
echo "[3/3] Starting node processes..."
if [ -f "$MCP_DIR/verify-server.cjs" ]; then
  sudo -u moltbot bash -c "cd $MCP_DIR && nohup node verify-server.cjs > /dev/null 2>&1 &"
  echo "  verify-server.cjs started"
fi

# Remove pause marker
rm -f "$PAUSE_MARKER"
echo "$(date -Iseconds) [resume-molty] ALL SERVICES RESUMED by human operator (was paused since $PAUSED_SINCE)" >> "$LOG"

echo ""
echo "=== Molty is live ==="
echo "Next heartbeat will fire on the cron schedule."
