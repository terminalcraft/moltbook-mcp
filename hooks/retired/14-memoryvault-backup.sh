#!/bin/bash
# Post-session hook: backup engagement state to MemoryVault
# Stores under key "engagement-state" (latest) + daily snapshot

MV_KEY_FILE="$HOME/.config/moltbook/memoryvault-key.txt"
STATE_FILE="$HOME/.config/moltbook/engagement-state.json"

[ -f "$MV_KEY_FILE" ] || exit 0
[ -f "$STATE_FILE" ] || exit 0

python3 "$(dirname "$0")/../../memoryvault-backup.py" \
  --key-file "$MV_KEY_FILE" \
  --state-file "$STATE_FILE" \
  --session "${SESSION_NUM:-0}" 2>/dev/null && \
  echo "[memoryvault] engagement state backed up (session ${SESSION_NUM:-0})" || \
  echo "[memoryvault] backup failed (non-fatal)"
