#!/bin/bash
# Pause all molty services. Run on VPS as root.
# Usage: pause-molty.sh

set -uo pipefail

STATE_DIR="/home/moltbot/.config/moltbook"
LOG="$STATE_DIR/logs/selfmod.log"
PAUSE_MARKER="$STATE_DIR/paused"

if [ -f "$PAUSE_MARKER" ]; then
  echo "Molty is already paused (since $(cat "$PAUSE_MARKER"))"
  exit 0
fi

echo "=== Pausing molty ==="

# 1. Save current crontab, then clear it
echo "[1/4] Disabling cron jobs..."
crontab -u moltbot -l > "$STATE_DIR/crontab.backup" 2>/dev/null
crontab -u moltbot -r 2>/dev/null || true
echo "  Crontab backed up to $STATE_DIR/crontab.backup"

# 2. Stop systemd services
echo "[2/4] Stopping systemd services..."
systemctl stop molty-api.service 2>/dev/null && echo "  molty-api stopped" || echo "  molty-api was not running"
systemctl stop molty-monitor.service 2>/dev/null && echo "  molty-monitor stopped" || echo "  molty-monitor was not running"

# 3. Kill node processes owned by moltbot (except PM2 daemon)
echo "[3/4] Killing moltbot node processes..."
pkill -u moltbot -f "node.*api.mjs" 2>/dev/null && echo "  api.mjs killed" || echo "  api.mjs was not running"
pkill -u moltbot -f "node.*monitor-api.mjs" 2>/dev/null && echo "  monitor-api.mjs killed" || echo "  monitor-api.mjs was not running"
pkill -u moltbot -f "node.*verify-server.cjs" 2>/dev/null && echo "  verify-server.cjs killed" || echo "  verify-server.cjs was not running"
pkill -u moltbot -f "node.*index.js" 2>/dev/null && echo "  MCP server killed" || echo "  MCP server was not running"
# Kill any running claude sessions
pkill -u moltbot -f "claude" 2>/dev/null && echo "  claude session killed" || echo "  no claude session running"

# 4. Write pause marker
echo "[4/4] Writing pause marker..."
date -Iseconds > "$PAUSE_MARKER"
echo "$(date -Iseconds) [pause-molty] ALL SERVICES PAUSED by human operator" >> "$LOG"

echo ""
echo "=== Molty is paused ==="
echo "Crontab backup: $STATE_DIR/crontab.backup"
echo "To resume: run resume-molty.sh"
