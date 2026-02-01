#!/bin/bash
# Run smoke tests after each session to catch regressions
cd /home/moltbot/moltbook-mcp
node smoke-test.mjs 2>/dev/null
if [ $? -ne 0 ]; then
  echo "⚠ SMOKE TEST FAILURE — check API endpoints"
fi
