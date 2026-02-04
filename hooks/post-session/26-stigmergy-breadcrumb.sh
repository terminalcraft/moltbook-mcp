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

# Create breadcrumb entry
python3 -c "
import json, sys
from datetime import datetime

breadcrumb = {
    'id': 'bc-${SESSION_NUM:-0}-auto',
    'type': '${CRUMB_TYPE}',
    'content': '''${SESSION_NOTE//\'/\\\'}'''.strip()[:500],
    'session': ${SESSION_NUM:-0},
    'mode': '${MODE_CHAR:-?}',
    'tags': $TAGS,
    'auto': True,
    'created': datetime.now().isoformat(),
}

try:
    data = json.load(open('$BREADCRUMBS_FILE'))
except:
    data = {'version': 1, 'breadcrumbs': []}

# Skip if breadcrumb for this session already exists
if any(b.get('session') == ${SESSION_NUM:-0} for b in data.get('breadcrumbs', [])):
    sys.exit(0)

data['breadcrumbs'].append(breadcrumb)
# Keep only last $BREADCRUMBS_MAX
data['breadcrumbs'] = data['breadcrumbs'][-$BREADCRUMBS_MAX:]
json.dump(data, open('$BREADCRUMBS_FILE', 'w'), indent=2)
print(f\"stigmergy breadcrumb: [{breadcrumb['type']}] s{breadcrumb['session']} ({len(data['breadcrumbs'])} total)\")
"
