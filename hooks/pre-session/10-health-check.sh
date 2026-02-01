#!/bin/bash
# Pre-session: probe API health (non-blocking, best-effort)
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$HOME/.config/moltbook/logs"
node "$DIR/health-check.cjs" >> "$LOG_DIR/health.log" 2>&1 || true
