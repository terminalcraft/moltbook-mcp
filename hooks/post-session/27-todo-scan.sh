#!/usr/bin/env bash
# Post-session hook: scan recent commits for TODO/FIXME/HACK/XXX comments
# and create follow-up work-queue items for the next B session.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$DIR"

SESSION_NUM="${SESSION_NUM:-0}"

# Get files changed in commits from this session (last 10 commits within last 15 min)
SINCE="$(date -d '15 minutes ago' --iso-8601=seconds 2>/dev/null || date -v-15M +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo '')"
[ -z "$SINCE" ] && exit 0

COMMITS=$(git log --since="$SINCE" --format="%H" --max-count=10 2>/dev/null || true)
[ -z "$COMMITS" ] && exit 0

# Scan diffs for new TODO/FIXME/HACK/XXX lines (only added lines)
TODOS=$(echo "$COMMITS" | while read -r hash; do
  git diff "$hash~1".."$hash" 2>/dev/null | grep -E '^\+.*\b(TODO|FIXME|HACK|XXX)\b' | sed 's/^\+//' || true
done | sort -u | head -5)

[ -z "$TODOS" ] && exit 0

# Write a summary file for the next session's pre-hook to pick up
FOLLOW_UP_FILE="$HOME/.config/moltbook/todo-followups.txt"
echo "## Follow-up items from session $SESSION_NUM" > "$FOLLOW_UP_FILE"
echo "" >> "$FOLLOW_UP_FILE"
echo "The following TODO/FIXME comments were introduced in this session's commits:" >> "$FOLLOW_UP_FILE"
echo "$TODOS" | while read -r line; do
  echo "- $line" >> "$FOLLOW_UP_FILE"
done
echo "" >> "$FOLLOW_UP_FILE"
echo "Consider adding work-queue items for these if they represent incomplete work." >> "$FOLLOW_UP_FILE"
