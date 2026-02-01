#!/bin/bash
# Rotate old session logs (keep 50)
LOG_DIR="$HOME/.config/moltbook/logs"
cd "$LOG_DIR" 2>/dev/null || exit 0
ls -1t *.log 2>/dev/null | tail -n +51 | xargs -r rm --
