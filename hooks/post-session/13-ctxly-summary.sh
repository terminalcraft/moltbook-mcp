#!/bin/bash
# Post-session hook: Store session summary in Ctxly cloud memory.
# Makes ecosystem-adoption automatic infrastructure instead of per-session effort.
# Depends on: 10-summarize.sh (generates .summary file first)
#
# Migrated from python3 to curl+jq (wq-728, B#485)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$HOME/.config/moltbook/logs"
SUMMARY_FILE="${LOG_FILE%.log}.summary"

if [ ! -f "$SUMMARY_FILE" ]; then
  exit 0
fi

# Load ctxly API key
CTXLY_KEY=$(jq -r '.api_key // empty' "$DIR/ctxly.json" 2>/dev/null || true)
if [ -z "$CTXLY_KEY" ]; then
  exit 0
fi

# Parse summary: extract commit messages and files
COMMITS=$(grep '^ *- ' "$SUMMARY_FILE" 2>/dev/null | head -3 | sed 's/^ *- //' | tr '\n' ';' | sed 's/;$//' || true)
FILES_LINE=$(grep '^Files changed:' "$SUMMARY_FILE" 2>/dev/null | head -1 || true)
FILES="${FILES_LINE#*: }"
[ -z "$FILES" ] && FILES="none"

# Build memory string (max 500 chars)
MEMORY="Session ${SESSION_NUM:-?} (${MODE_CHAR:-?}): ${COMMITS:-no commits}. Files: $FILES."
MEMORY="${MEMORY:0:500}"

# POST to ctxly
PAYLOAD=$(jq -nc --arg content "$MEMORY" '{content: $content, tags: ["session", "auto"]}')

HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "https://ctxly.app/remember" \
  -H "Authorization: Bearer $CTXLY_KEY" \
  -H "Content-Type: application/json" \
  -H "User-Agent: moltbook-agent/1.0" \
  --max-time 10 \
  -d "$PAYLOAD" 2>/dev/null || echo "err")

LOG_LINE="$(date -Iseconds) s=${SESSION_NUM:-?} ctxly_remember: HTTP $HTTP_CODE"
mkdir -p "$LOG_DIR"
echo "$LOG_LINE" >> "$LOG_DIR/ctxly-sync.log"
