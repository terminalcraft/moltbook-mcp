#!/bin/bash
# Post-session hook: write structured JSON outcome per session.
# Reads cost from cost-history.json (written by 15-cost-pipeline.sh which runs first).
# Expects env: MODE_CHAR, SESSION_NUM, LOG_FILE, SESSION_EXIT, SESSION_OUTCOME, R_FOCUS, B_FOCUS

set -euo pipefail

OUTCOMES_FILE="$HOME/.config/moltbook/session-outcomes.json"
COST_FILE="$HOME/.config/moltbook/cost-history.json"

# Initialize if missing
if [ ! -f "$OUTCOMES_FILE" ]; then
  echo '[]' > "$OUTCOMES_FILE"
fi

# Extract cost from cost-history.json (last entry matching this session)
COST=$(jq -r "[.[] | select(.session == ${SESSION_NUM:-0})] | last | (.cost // .spent // 0)" "$COST_FILE" 2>/dev/null || echo 0)

# Count commits made during session (from git log timestamps vs session log)
COMMITS=0
if [ -f "$LOG_FILE" ]; then
  COMMITS=$(grep -c '"type":"tool_result".*git commit\|committed.*files changed\|create mode' "$LOG_FILE" 2>/dev/null || echo 0)
  # Fallback: count commit hashes in log
  if [ "$COMMITS" = "0" ]; then
    COMMITS=$(grep -oP '\b[0-9a-f]{7,40}\b.*\bcommit\b|\bcommit\b.*\b[0-9a-f]{7,40}\b' "$LOG_FILE" 2>/dev/null | wc -l || echo 0)
  fi
fi

# Extract files changed from git (last N commits from this session)
FILES_CHANGED=""
if command -v git &>/dev/null; then
  cd "$(dirname "$0")/../.." 2>/dev/null || true
  FILES_CHANGED=$(git diff --name-only HEAD~3 HEAD 2>/dev/null | sort -u | tr '\n' ',' | sed 's/,$//' || echo "")
fi

# Determine focus
FOCUS=""
[ -n "${B_FOCUS:-}" ] && FOCUS="$B_FOCUS"
[ -n "${R_FOCUS:-}" ] && FOCUS="$R_FOCUS"

# Write entry (jq — no python3 dependency)
FOCUS_JSON="null"
[ -n "$FOCUS" ] && FOCUS_JSON="\"$FOCUS\""
FILES_JSON="[]"
[ -n "$FILES_CHANGED" ] && FILES_JSON=$(echo "$FILES_CHANGED" | jq -R 'split(",") | map(select(length > 0))' 2>/dev/null || echo '[]')

jq --argjson entry "$(jq -n \
  --arg ts "$(date -Iseconds)" \
  --argjson session "${SESSION_NUM:-0}" \
  --arg mode "${MODE_CHAR:-?}" \
  --argjson focus "$FOCUS_JSON" \
  --argjson exit_code "${SESSION_EXIT:-1}" \
  --arg outcome "${SESSION_OUTCOME:-unknown}" \
  --argjson cost "${COST}" \
  --argjson files "$FILES_JSON" \
  '{timestamp: $ts, session: $session, mode: $mode, focus: $focus, exit_code: $exit_code, outcome: $outcome, cost_usd: $cost, files_changed: $files}')" \
  '. + [$entry] | .[-200:]' "$OUTCOMES_FILE" > "${OUTCOMES_FILE}.tmp" && mv "${OUTCOMES_FILE}.tmp" "$OUTCOMES_FILE"

echo "$(date -Iseconds) structured outcome logged: s=${SESSION_NUM:-?} ${SESSION_OUTCOME:-?} \$${COST}"
