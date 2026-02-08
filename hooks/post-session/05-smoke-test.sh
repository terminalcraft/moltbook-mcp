#!/bin/bash
# Run smoke tests after each session to catch regressions
# Fixed wq-445: handle server-down gracefully, only report real failures
LOG_DIR="$HOME/.config/moltbook/logs"
cd /home/moltbot/moltbook-mcp

# Check if API is reachable before running smoke tests
if ! curl -sf -o /dev/null --max-time 3 http://127.0.0.1:3847/health 2>/dev/null; then
  echo "$(date -Iseconds) s=${SESSION_NUM:-?} SKIP: API not reachable" >> "$LOG_DIR/smoke-errors.log"
  exit 0
fi

SMOKE_OUT=$(node smoke-test.mjs 2>&1)
SMOKE_EXIT=$?
if [ $SMOKE_EXIT -ne 0 ]; then
  # Extract failure count from output
  FAIL_LINE=$(echo "$SMOKE_OUT" | grep -oP '\d+/\d+ passed')
  echo "$(date -Iseconds) s=${SESSION_NUM:-?} FAIL ($FAIL_LINE): ${SMOKE_OUT:0:300}" >> "$LOG_DIR/smoke-errors.log"
  echo "⚠ SMOKE TEST FAILURE ($FAIL_LINE) — check smoke-errors.log"
fi
