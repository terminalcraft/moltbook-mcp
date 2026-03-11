#!/usr/bin/env bash
# Post-session hook: scan recent commits for TODO/FIXME/HACK/XXX comments
# and track them across sessions in a persistent JSON file.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$DIR"

SESSION_NUM="${SESSION_NUM:-0}"
TRACKER="$HOME/.config/moltbook/todo-tracker.json"
FOLLOW_UP_FILE="$HOME/.config/moltbook/todo-followups.txt"
FALSE_POSITIVES="$DIR/todo-false-positives.json"

# Initialize tracker if missing
if [ ! -f "$TRACKER" ]; then
  echo '{"items":[]}' > "$TRACKER"
fi

# --- Phase 1: Scan this session's commits for new TODOs ---
SINCE="$(date -d '15 minutes ago' --iso-8601=seconds 2>/dev/null || date -v-15M +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo '')"
[ -z "$SINCE" ] && exit 0

COMMITS=$(git log --since="$SINCE" --format="%H" --max-count=10 2>/dev/null || true)

NEW_TODOS=""
# Exclude infrastructure files that contain TODO/FIXME as template text
EXCLUDE_PATHS=":(exclude)session-context.mjs :(exclude)work-queue.js :(exclude)work-queue.json :(exclude)hooks/post-session/27-todo-scan.sh :(exclude)hooks/post-session/42-todo-followups.sh :(exclude)hooks/lib/todo-scan.mjs :(exclude)*.test.mjs :(exclude)*.test.js :(exclude)*.spec.mjs :(exclude)*.spec.js :(exclude)*.md :(exclude)BRAINSTORMING.md :(exclude)summarize-session.py :(exclude)prediction-log.json :(exclude)credential-health-check.mjs :(exclude)todo-false-positives.json :(exclude)lib/queue-pipeline.mjs"
if [ -n "$COMMITS" ]; then
  NEW_TODOS=$(echo "$COMMITS" | while read -r hash; do
    git diff "$hash~1".."$hash" -- . $EXCLUDE_PATHS 2>/dev/null | grep -E '^\+.*\b(TODO|FIXME|HACK|XXX)\b' | sed 's/^\+//' || true
  done | sort -u | \
    # Filter out false positives (wq-299, wq-320):
    grep -vE '^\s*\|' | \
    grep -vE 'wq-[0-9X]+' | \
    grep -vE '^\s*#\s*Pattern\s*[0-9]+' | \
    grep -vE '\*[BREA]#[0-9]+' | \
    grep -vE '"notes":\s*"' | \
    grep -vE '^\s*\*[A-Z]' | \
    grep -vE '"[^"]*TODO[^"]*"' | \
    grep -vE "'[^']*TODO[^']*'" | \
    grep -vE "'[^']*XXX[^']*'" | \
    grep -vE "'[^']*REPLACE_ME[^']*'" | \
    grep -vE '\{[[:space:]]*pattern:[[:space:]]*/' | \
    grep -vE 'risk:[[:space:]]*[0-9.]+,[[:space:]]*reason:' | \
    grep -vE 'assert\(.*\b(TODO|FIXME)\b' | \
    grep -vE 'console\.log\(.*\b(TODO|FIXME)\b' | \
    grep -vE '^\s*"[^"]+"\s*:' | \
    grep -vE '^\s*//\s*---\s+' | \
    grep -vE '\btests? added:' | \
    head -10 || true)
fi

# --- Phase 2: Update tracker with new items (with false-positive filtering) ---
if [ -n "$NEW_TODOS" ]; then
  TRACKER="$TRACKER" FALSE_POSITIVES="$FALSE_POSITIVES" SESSION_NUM="$SESSION_NUM" \
    NEW_TODOS="$NEW_TODOS" node hooks/lib/todo-scan.mjs merge 2>/dev/null || true
fi

# --- Phase 3: Auto-resolve false positives + check if tracked TODOs resolved ---
TRACKER="$TRACKER" FALSE_POSITIVES="$FALSE_POSITIVES" SESSION_NUM="$SESSION_NUM" \
  node hooks/lib/todo-scan.mjs resolve 2>/dev/null || true

# --- Phase 4: Write follow-up file for session-context injection ---
if [ -n "$NEW_TODOS" ]; then
  echo "## Follow-up items from session $SESSION_NUM" > "$FOLLOW_UP_FILE"
  echo "" >> "$FOLLOW_UP_FILE"
  echo "The following TODO/FIXME comments were introduced in this session's commits:" >> "$FOLLOW_UP_FILE"
  echo "$NEW_TODOS" | while read -r line; do
    echo "- $line" >> "$FOLLOW_UP_FILE"
  done
  echo "" >> "$FOLLOW_UP_FILE"
  echo "Consider adding work-queue items for these if they represent incomplete work." >> "$FOLLOW_UP_FILE"
fi
