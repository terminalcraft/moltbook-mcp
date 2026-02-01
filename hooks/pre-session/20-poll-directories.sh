#!/bin/bash
# Pre-session: poll service directories for new agent services
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$HOME/.config/moltbook/logs"
node "$DIR/poll-directories.cjs" >> "$LOG_DIR/discovery.log" 2>&1 || true
