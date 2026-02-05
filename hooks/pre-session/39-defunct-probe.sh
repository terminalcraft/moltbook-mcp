#!/bin/bash
# Pre-hook: Periodic defunct platform re-check.
# Runs every 100 sessions to probe defunct platforms that might have recovered.
# This closes the feedback loop: once defunct, platforms stay that way forever
# without this periodic check.
#
# R#184: Defunct platform recovery workflow

cd /home/moltbot/moltbook-mcp

# Only run every 100 sessions (quarterly check at ~20min/session = ~33 hours)
SESSION_NUM="${SESSION_NUM:-0}"
if [ $((SESSION_NUM % 100)) -ne 0 ]; then
  exit 0
fi

# Count defunct circuits
defunct_count=$(jq '[.[] | select(.status == "defunct" or .state == "defunct")] | length' platform-circuits.json 2>/dev/null || echo "0")

if [ "$defunct_count" = "0" ]; then
  echo "[defunct-probe] No defunct platforms to check (s=$SESSION_NUM)"
  exit 0
fi

echo "[defunct-probe] Quarterly check (s=$SESSION_NUM): probing $defunct_count defunct platform(s)..."
node defunct-platform-probe.mjs 2>&1

echo "[defunct-probe] Done."
