#!/bin/bash
# Run smoke tests after each session to catch regressions
LOG_DIR="$HOME/.config/moltbook/logs"
cd /home/moltbot/moltbook-mcp
SMOKE_OUT=$(node smoke-test.mjs 2>&1) || {
  echo "$(date -Iseconds) s=${SESSION_NUM:-?} FAIL: ${SMOKE_OUT:0:300}" >> "$LOG_DIR/smoke-errors.log"
  echo "⚠ SMOKE TEST FAILURE — check smoke-errors.log"
}
