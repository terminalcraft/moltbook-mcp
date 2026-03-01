#!/bin/bash
# Post-session hook: auto-leave stigmergic breadcrumbs for future sessions.
# Reads session summary and creates breadcrumb traces.
# Expects env: MODE_CHAR, SESSION_NUM, LOG_FILE, SESSION_EXIT, SESSION_OUTCOME

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BREADCRUMBS_FILE="$DIR/stigmergy-breadcrumbs.json"
SUMMARY_FILE="${LOG_FILE%.log}.summary"
HISTORY_FILE="$HOME/.config/moltbook/session-history.txt"
BREADCRUMBS_MAX=100

# Initialize breadcrumbs file if missing
if [ ! -f "$BREADCRUMBS_FILE" ]; then
  echo '{"version": 1, "description": "Session breadcrumbs for stigmergic coordination", "breadcrumbs": []}' > "$BREADCRUMBS_FILE"
fi

# Get session note from history (most reliable source)
SESSION_NOTE=""
if [ -f "$HISTORY_FILE" ]; then
  SESSION_NOTE=$(grep "s=${SESSION_NUM:-0} " "$HISTORY_FILE" 2>/dev/null | tail -1 | sed 's/.*note: //' || true)
fi

# Fallback: extract from summary file
if [ -z "$SESSION_NOTE" ] && [ -f "$SUMMARY_FILE" ]; then
  SESSION_NOTE=$(awk '/^Build:/ { in_build=1; next } /^[A-Z]/ { in_build=0 } in_build && /^ *- / { gsub(/^ *- /, ""); print; exit }' "$SUMMARY_FILE" || true)
fi

# Skip if no meaningful note
[ -z "$SESSION_NOTE" ] && exit 0

# Determine breadcrumb type based on session mode and content
CRUMB_TYPE="discovery"
case "${MODE_CHAR:-?}" in
  B) CRUMB_TYPE="approach"
     # If note contains "fix" it's a lesson learned
     echo "$SESSION_NOTE" | grep -iq 'fix\|fixed\|resolve\|repair' && CRUMB_TYPE="lesson" ;;
  R) CRUMB_TYPE="lesson"
     # R sessions are always lessons/reflections
     ;;
  E) CRUMB_TYPE="discovery"
     # E sessions discover things about platforms
     ;;
  A) CRUMB_TYPE="warning"
     # A sessions flag issues
     ;;
esac

# Determine tags based on content
TAGS="[]"
TAG_LIST=""
echo "$SESSION_NOTE" | grep -iq 'test' && TAG_LIST="$TAG_LIST\"testing\","
echo "$SESSION_NOTE" | grep -iq 'api\|endpoint' && TAG_LIST="$TAG_LIST\"api\","
echo "$SESSION_NOTE" | grep -iq 'hook' && TAG_LIST="$TAG_LIST\"hooks\","
echo "$SESSION_NOTE" | grep -iq 'engage\|platform\|chatr\|4claw' && TAG_LIST="$TAG_LIST\"engagement\","
echo "$SESSION_NOTE" | grep -iq 'cost\|budget' && TAG_LIST="$TAG_LIST\"cost\","
echo "$SESSION_NOTE" | grep -iq 'directive\|d0[0-9][0-9]' && TAG_LIST="$TAG_LIST\"directive\","
echo "$SESSION_NOTE" | grep -iq 'wq-' && TAG_LIST="$TAG_LIST\"work-queue\","
echo "$SESSION_NOTE" | grep -iq 'pattern\|knowledge' && TAG_LIST="$TAG_LIST\"knowledge\","
[ -n "$TAG_LIST" ] && TAGS="[${TAG_LIST%,}]"

# Create breadcrumb entry (jq — no python3 dependency)
# Skip if breadcrumb for this session already exists
if jq -e ".breadcrumbs[] | select(.session == ${SESSION_NUM:-0})" "$BREADCRUMBS_FILE" >/dev/null 2>&1; then
  exit 0
fi

# Truncate note to 500 chars for breadcrumb content
CONTENT=$(echo "$SESSION_NOTE" | head -c 500)

jq --argjson bc "$(jq -n \
  --arg id "bc-${SESSION_NUM:-0}-auto" \
  --arg type "$CRUMB_TYPE" \
  --arg content "$CONTENT" \
  --argjson session "${SESSION_NUM:-0}" \
  --arg mode "${MODE_CHAR:-?}" \
  --argjson tags "$TAGS" \
  --arg created "$(date -Iseconds)" \
  '{id: $id, type: $type, content: $content, session: $session, mode: $mode, tags: $tags, auto: true, created: $created}')" \
  ".breadcrumbs += [\$bc] | .breadcrumbs = .breadcrumbs[-${BREADCRUMBS_MAX}:]" \
  "$BREADCRUMBS_FILE" > "${BREADCRUMBS_FILE}.tmp" && mv "${BREADCRUMBS_FILE}.tmp" "$BREADCRUMBS_FILE"

TOTAL=$(jq '.breadcrumbs | length' "$BREADCRUMBS_FILE" 2>/dev/null || echo "?")
echo "stigmergy breadcrumb: [${CRUMB_TYPE}] s${SESSION_NUM:-0} (${TOTAL} total)"
