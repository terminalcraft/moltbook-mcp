#!/bin/bash
# 34-cred-health-cleanup_A.sh — Prune recovered entries from credential-health-state.json
# Created: B#543 (wq-850)
#
# Removes entries with consecutive_failures=0 (recovered platforms),
# flags entries >50 sessions old as stale, validates schema.
# Non-blocking: cleanup failures don't prevent session start.
set -euo pipefail

STATE_FILE="$HOME/.config/moltbook/credential-health-state.json"
SESSION="${SESSION_NUM:-0}"

if [ ! -f "$STATE_FILE" ]; then
  echo "[cred-health] OK: no state file to clean"
  exit 0
fi

# Validate JSON
if ! jq empty "$STATE_FILE" 2>/dev/null; then
  echo "[cred-health] WARN: invalid JSON in credential-health-state.json"
  exit 0
fi

# Prune recovered entries (consecutive_failures=0) and flag stale entries (>50 sessions old)
RESULT=$(jq --argjson session "$SESSION" '
  to_entries |
  # Remove recovered entries (consecutive_failures == 0)
  map(select(.value.consecutive_failures > 0)) |
  # Flag stale entries (last_session more than 50 sessions ago)
  map(
    if ($session - (.value.last_session // 0)) > 50
    then .value.stale = true
    else .
    end
  ) |
  from_entries
' "$STATE_FILE") || {
  echo "[cred-health] WARN: jq processing failed"
  exit 0
}

BEFORE=$(jq 'length' "$STATE_FILE")
echo "$RESULT" > "$STATE_FILE"
AFTER=$(echo "$RESULT" | jq 'length')
STALE=$(echo "$RESULT" | jq '[to_entries[] | select(.value.stale)] | length')

PRUNED=$((BEFORE - AFTER))
if [ "$PRUNED" -gt 0 ] || [ "$STALE" -gt 0 ]; then
  echo "[cred-health] Pruned $PRUNED recovered, $STALE stale of $BEFORE entries"
else
  echo "[cred-health] OK: $AFTER entries, 0 recovered, 0 stale"
fi

exit 0
