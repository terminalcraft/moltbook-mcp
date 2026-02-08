#!/bin/bash
# B#375 (wq-467): Log session start to session-history.txt as fallback.
# If post-session hooks fail to run (timeout, crash, SIGKILL), this
# placeholder entry ensures the session is visible in the history.
# The post-session 10-summarize.sh overwrites this with the full entry
# via its dedup check (grep "s=$SESSION_NUM ").
#
# Format: same as 10-summarize.sh but with placeholder values.
set -euo pipefail

HISTORY_FILE="$HOME/.config/moltbook/session-history.txt"

# Only write if this session isn't already logged (idempotent)
if [ -f "$HISTORY_FILE" ] && grep -q "s=$SESSION_NUM " "$HISTORY_FILE"; then
  exit 0
fi

echo "$(date +%Y-%m-%d) mode=$MODE_CHAR s=$SESSION_NUM dur=? build=(started) files=[(none)] note: session started, awaiting completion" >> "$HISTORY_FILE"
