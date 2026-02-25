#!/bin/bash
# Post-session hook: Track R session structural change impact.
# R#263: Rewrote from 340-line bash+inline-python to thin wrapper
#        calling lib/r-impact-tracker.mjs (testable, consistent with codebase).
#
# Logic: detect structural file changes from git, classify category + intent,
# delegate to Node.js for recording and impact analysis.
#
# Expects env: MODE_CHAR, SESSION_NUM

set -euo pipefail

# Only run for R sessions
[ "${MODE_CHAR:-}" = "R" ] || exit 0

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$DIR" 2>/dev/null || true

# --- Detect structural change from git ---
CHANGE_FILE=$(git diff --name-only HEAD~2 HEAD 2>/dev/null \
  | grep -E '\.(sh|js|mjs|md|conf)$' | head -1 || echo "")

LATEST_COMMIT_MSG=$(git log -1 --format="%s" 2>/dev/null || echo "")

# Filter pipeline repair operations (operational, not structural)
if [[ "$LATEST_COMMIT_MSG" =~ ^chore:.*pipeline.*repair ]] || \
   [[ "$LATEST_COMMIT_MSG" =~ ^chore:.*replenish ]]; then
  echo "$(date -Iseconds) r-impact-track: skipping pipeline repair edit to $CHANGE_FILE"
  exit 0
fi

# Classify category from filename
CHANGE_CATEGORY=""
if [ -n "$CHANGE_FILE" ]; then
  case "$CHANGE_FILE" in
    SESSION_*.md) CHANGE_CATEGORY="session-file" ;;
    heartbeat.sh|rotation.conf|rotation-state.mjs) CHANGE_CATEGORY="orchestration" ;;
    hooks/*) CHANGE_CATEGORY="hooks" ;;
    index.js|api.mjs) CHANGE_CATEGORY="mcp-server" ;;
    components/*|providers/*) CHANGE_CATEGORY="components" ;;
    *.test.mjs|*.test.js) CHANGE_CATEGORY="tests" ;;
    BRAINSTORMING.md|work-queue.json|directives.json) CHANGE_CATEGORY="state-files" ;;
    *) CHANGE_CATEGORY="other" ;;
  esac
fi

# Detect intent from commit message
CHANGE_INTENT=""
if [[ "$LATEST_COMMIT_MSG" =~ enforce.*budget ]] || \
   [[ "$LATEST_COMMIT_MSG" =~ budget.*minimum ]] || \
   [[ "$LATEST_COMMIT_MSG" =~ increase.*spending ]]; then
  CHANGE_INTENT="cost_increase"
elif [[ "$LATEST_COMMIT_MSG" =~ reduce.*cost ]] || \
     [[ "$LATEST_COMMIT_MSG" =~ lower.*budget ]] || \
     [[ "$LATEST_COMMIT_MSG" =~ optimize.*spending ]]; then
  CHANGE_INTENT="cost_decrease"
fi

# Delegate to Node.js module for recording + analysis
node "$DIR/lib/r-impact-tracker.mjs" \
  "${SESSION_NUM:-0}" "$CHANGE_FILE" "$CHANGE_CATEGORY" "$CHANGE_INTENT"

echo "$(date -Iseconds) r-impact-track: s=${SESSION_NUM:-?} category=${CHANGE_CATEGORY:-none}"
