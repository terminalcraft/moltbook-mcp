#!/bin/bash
# 37-scope-bleed-detect_E.sh — Detect build commits in E sessions (wq-712)
#
# E sessions should focus on engagement, not code changes. If git log shows
# commits made during this session, flag it as scope bleed. This is a
# proactive warning complementing the audit-stats.mjs detection (wq-711).
#
# Created: B#475 (wq-712)
set -euo pipefail

: "${SESSION_NUM:?SESSION_NUM required}"
MCP_DIR="$(dirname "$(dirname "$(dirname "$(realpath "$0")")")")"
STATE_DIR="$HOME/.config/moltbook"
LOG_FILE="${LOG_DIR:-$STATE_DIR/logs}/hooks.log"

cd "$MCP_DIR" || exit 0

# Count commits made in this session by checking git log for auto-snapshot marker
# Session commits are between the pre-session auto-snapshot and now
# Use a simple heuristic: commits in the last 15 minutes that aren't auto-snapshots
RECENT_COMMITS=$(git log --oneline --since="15 minutes ago" 2>/dev/null | grep -cv "auto-snapshot" || true)

if [ "$RECENT_COMMITS" -gt 0 ]; then
  COMMIT_LIST=$(git log --oneline --since="15 minutes ago" 2>/dev/null | grep -v "auto-snapshot" | head -5)
  echo "$(date -Iseconds) SCOPE-BLEED WARNING: E session s${SESSION_NUM} has ${RECENT_COMMITS} build commit(s):" >> "$LOG_FILE"
  echo "$COMMIT_LIST" >> "$LOG_FILE"
  echo "SCOPE-BLEED: E session s${SESSION_NUM} made ${RECENT_COMMITS} code commit(s) — build work bled into engagement"
fi

exit 0
