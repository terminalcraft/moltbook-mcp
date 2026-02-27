#!/usr/bin/env bash
# Post-session hook: scan recent commits for TODO/FIXME/HACK/XXX comments
# and track them across sessions in a persistent JSON file.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$DIR"

SESSION_NUM="${SESSION_NUM:-0}"
TRACKER="$HOME/.config/moltbook/todo-tracker.json"
FOLLOW_UP_FILE="$HOME/.config/moltbook/todo-followups.txt"

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
EXCLUDE_PATHS=":(exclude)session-context.mjs :(exclude)work-queue.js :(exclude)work-queue.json :(exclude)hooks/post-session/27-todo-scan.sh :(exclude)hooks/post-session/42-todo-followups.sh :(exclude)*.test.mjs :(exclude)*.test.js :(exclude)*.spec.mjs :(exclude)*.spec.js :(exclude)*.md :(exclude)BRAINSTORMING.md :(exclude)summarize-session.py :(exclude)prediction-log.json"
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
    head -10 || true)
fi

# --- Phase 2: Update tracker with new items ---
if [ -n "$NEW_TODOS" ]; then
  # Use node to merge new TODOs into tracker
  node -e "
    const fs = require('fs');
    const tracker = JSON.parse(fs.readFileSync('$TRACKER', 'utf8'));
    const newLines = $(echo "$NEW_TODOS" | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]');
    for (const line of newLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Deduplicate by content (fuzzy: strip whitespace/line numbers)
      const normalized = trimmed.replace(/\s+/g, ' ').substring(0, 200);
      const exists = tracker.items.find(i => i.normalized === normalized && i.status === 'open');
      if (!exists) {
        tracker.items.push({
          text: trimmed.substring(0, 300),
          normalized,
          first_seen: $SESSION_NUM,
          last_seen: $SESSION_NUM,
          status: 'open'
        });
      } else {
        exists.last_seen = $SESSION_NUM;
      }
    }
    fs.writeFileSync('$TRACKER', JSON.stringify(tracker, null, 2) + '\n');
  " 2>/dev/null || true
fi

# --- Phase 3: Check if any tracked TODOs have been resolved ---
# Scan codebase for open tracked items
node -e "
  const fs = require('fs');
  const { execSync } = require('child_process');
  const tracker = JSON.parse(fs.readFileSync('$TRACKER', 'utf8'));
  let changed = false;
  for (const item of tracker.items) {
    if (item.status !== 'open') continue;
    // Extract a unique-ish substring to grep for (first 60 chars of normalized)
    const needle = item.normalized.substring(0, 60).replace(/[\"\\\\]/g, '');
    if (!needle || needle.length < 10) continue;
    try {
      execSync('grep -rF \"' + needle + '\" --include=\"*.js\" --include=\"*.mjs\" --include=\"*.sh\" --include=\"*.json\" . 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      // Still present — update last_seen
      item.last_seen = $SESSION_NUM;
      changed = true;
    } catch {
      // Not found — mark resolved
      item.status = 'resolved';
      item.resolved_session = $SESSION_NUM;
      changed = true;
    }
  }
  // Prune: keep max 50 items, drop oldest resolved
  if (tracker.items.length > 50) {
    const resolved = tracker.items.filter(i => i.status === 'resolved');
    resolved.sort((a, b) => a.resolved_session - b.resolved_session);
    const toRemove = resolved.slice(0, tracker.items.length - 50);
    tracker.items = tracker.items.filter(i => !toRemove.includes(i));
    changed = true;
  }
  if (changed) fs.writeFileSync('$TRACKER', JSON.stringify(tracker, null, 2) + '\n');

  // Report
  const open = tracker.items.filter(i => i.status === 'open');
  const stale = open.filter(i => $SESSION_NUM - i.first_seen >= 10);
  if (open.length > 0) {
    console.log('TODO tracker: ' + open.length + ' open (' + stale.length + ' stale 10+ sessions)');
  }
" 2>/dev/null || true

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
