#!/bin/bash
# Moltbook heartbeat — fresh session each run, state lives on disk.
#
# Install: crontab -e → */20 * * * * /path/to/moltbook-mcp/heartbeat.sh
# Manual:  /path/to/moltbook-mcp/heartbeat.sh

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="$STATE_DIR/logs"
mkdir -p "$LOG_DIR"

# Kill orphan MCP node processes from previous crashed sessions
pkill -f "node $DIR/index.js" 2>/dev/null || true
sleep 1

LOCKFILE="$STATE_DIR/heartbeat.lock"
exec 200>"$LOCKFILE"
if ! flock -n 200; then
  echo "$(date -Iseconds) heartbeat already running, skipping" >> "$LOG_DIR/skipped.log"
  exit 0
fi

# Probe API health before session (non-blocking, best-effort)
node "$DIR/health-check.cjs" >> "$LOG_DIR/health.log" 2>&1 || true
# Poll known service directories for new agent services (best-effort)
node "$DIR/poll-directories.cjs" >> "$LOG_DIR/discovery.log" 2>&1 || true

# Outage-aware session skip: if API has been down 5+ consecutive checks,
# skip every other heartbeat to conserve budget during extended outages.
# Uses --status exit code: 0=up, 1=down, 2=unknown
SKIP_FILE="$STATE_DIR/outage_skip_toggle"
API_STATUS=$(node "$DIR/health-check.cjs" --status 2>&1 || true)
if echo "$API_STATUS" | grep -q "^DOWN" ; then
  DOWN_COUNT=$(echo "$API_STATUS" | grep -oP 'down \K[0-9]+')
  if [ "${DOWN_COUNT:-0}" -ge 5 ]; then
    if [ -f "$SKIP_FILE" ]; then
      rm -f "$SKIP_FILE"
      echo "$(date -Iseconds) outage skip: API down $DOWN_COUNT checks, skipping this session" >> "$LOG_DIR/skipped.log"
      exit 0
    else
      touch "$SKIP_FILE"
      # Continue — run this session, skip next one
    fi
  else
    rm -f "$SKIP_FILE"
  fi
else
  rm -f "$SKIP_FILE"
fi

# --- Session rotation ---
ROTATION_FILE="$DIR/rotation.conf"
SESSION_COUNTER_FILE="$STATE_DIR/session_counter"

# Accept optional mode override as first argument (E, B, or R)
OVERRIDE_MODE="${1:-}"

# Always read session counter (used for logging even on override)
if [ -f "$SESSION_COUNTER_FILE" ]; then
  COUNTER=$(cat "$SESSION_COUNTER_FILE")
else
  COUNTER=0
fi

if [ -n "$OVERRIDE_MODE" ]; then
  MODE_CHAR="$OVERRIDE_MODE"
else

  # Read pattern (default EBR)
  PATTERN="EBR"
  if [ -f "$ROTATION_FILE" ]; then
    PAT_LINE=$(grep '^PATTERN=' "$ROTATION_FILE" | tail -1)
    if [ -n "$PAT_LINE" ]; then
      PATTERN="${PAT_LINE#PATTERN=}"
    fi
  fi

  # Pick mode from pattern
  PAT_LEN=${#PATTERN}
  IDX=$((COUNTER % PAT_LEN))
  MODE_CHAR="${PATTERN:$IDX:1}"

  # Increment counter
  echo $((COUNTER + 1)) > "$SESSION_COUNTER_FILE"
fi

case "$MODE_CHAR" in
  R) MODE_FILE="$DIR/SESSION_REFLECT.md"; BUDGET="5.00" ;;
  B) MODE_FILE="$DIR/SESSION_BUILD.md"; BUDGET="10.00" ;;
  *) MODE_FILE="$DIR/SESSION_ENGAGE.md"; BUDGET="5.00" ;;
esac

# Build mode prompt
MODE_PROMPT=""
if [ -f "$MODE_FILE" ]; then
  MODE_PROMPT="$(cat "$MODE_FILE")"
fi

LOG="$LOG_DIR/$(date +%Y%m%d_%H%M%S).log"

# Load base prompt from file (editable without shell escaping concerns)
BASE_PROMPT=""
if [ -f "$DIR/base-prompt.md" ]; then
  BASE_PROMPT="$(cat "$DIR/base-prompt.md")"
else
  echo "$(date -Iseconds) WARNING: base-prompt.md missing, using minimal prompt" >> "$LOG_DIR/errors.log"
  BASE_PROMPT="You are an autonomous agent on Moltbook. Read ~/moltbook-mcp/BRIEFING.md for instructions."
fi

# Assemble full prompt: base identity + session-specific instructions
PROMPT="${BASE_PROMPT}

${MODE_PROMPT}"

# MCP config pointing to the local server
MCP_FILE="$STATE_DIR/mcp.json"
cat > "$MCP_FILE" <<MCPEOF
{
  "mcpServers": {
    "moltbook": {
      "command": "node",
      "args": ["$DIR/index.js"],
      "env": {
        "SESSION_TYPE": "$MODE_CHAR"
      }
    }
  }
}
MCPEOF

echo "=== Moltbook heartbeat $(date -Iseconds) mode=$MODE_CHAR ===" | tee "$LOG"

# 15-minute timeout prevents a hung session from blocking all future ticks.
# SIGTERM lets claude clean up; if it doesn't exit in 30s, SIGKILL follows.
timeout --signal=TERM --kill-after=30 900 \
  claude --model claude-opus-4-5-20251101 \
  -p "$PROMPT" \
  --output-format stream-json --verbose \
  --max-budget-usd "$BUDGET" \
  --mcp-config "$MCP_FILE" \
  --permission-mode bypassPermissions \
  200>&- 2>&1 | tee -a "$LOG"

EXIT_CODE=${PIPESTATUS[0]}
if [ "$EXIT_CODE" -eq 124 ]; then
  echo "$(date -Iseconds) session killed by timeout (15m)" >> "$LOG_DIR/timeouts.log"
fi

echo "=== Done $(date -Iseconds) ===" | tee -a "$LOG"

# Log rotation — keep newest 50 session logs
cd "$LOG_DIR"
ls -1t *.log 2>/dev/null | tail -n +51 | xargs -r rm --

# Generate readable summary from stream-json log
python3 "$DIR/scripts/summarize-session.py" "$LOG" "$COUNTER" 2>/dev/null || true

# Append one-line session history for cheap cross-session context
SUMMARY_FILE="${LOG%.log}.summary"
HISTORY_FILE="$STATE_DIR/session-history.txt"
if [ -f "$SUMMARY_FILE" ]; then
  S_NUM=$(grep '^Session:' "$SUMMARY_FILE" | head -1 | awk '{print $2}')
  S_DUR=$(grep '^Duration:' "$SUMMARY_FILE" | head -1 | awk '{print $2}')
  S_BUILD=$(grep '^Build:' "$SUMMARY_FILE" | head -1 | cut -d' ' -f2-)
  S_FILES=$(grep '^Files changed:' "$SUMMARY_FILE" | head -1 | cut -d' ' -f3-)
  S_COMMITS=$(grep '^ *- ' "$SUMMARY_FILE" | head -1 | sed 's/^ *- //')
  echo "$(date +%Y-%m-%d) mode=$MODE_CHAR s=$S_NUM dur=$S_DUR build=$S_BUILD files=[$S_FILES] ${S_COMMITS:+note: $S_COMMITS}" >> "$HISTORY_FILE"
  # Keep last 30 entries
  if [ "$(wc -l < "$HISTORY_FILE")" -gt 30 ]; then
    tail -30 "$HISTORY_FILE" > "$HISTORY_FILE.tmp" && mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"
  fi
fi

# Auto-version any uncommitted changes after session
cd "$DIR"
if \! git diff --quiet HEAD 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard 2>/dev/null)" ]; then
  # Selective add: only stage known-safe file types instead of blanket -A.
  # Prevents accidentally committing binaries, temp files, or anything
  # .gitignore might miss.
  git add -- '*.md' '*.js' '*.cjs' '*.mjs' '*.json' '*.sh' '*.py' '*.txt' \
    '.gitignore' 'LICENSE' 2>/dev/null || true
  # Also add any tracked files that were modified (catches renames, etc.)
  git add -u 2>/dev/null || true
  # Validate critical shell scripts before committing — revert broken ones
  for f in heartbeat.sh send_heartbeat.sh; do
    if [ -f "$f" ] && \! bash -n "$f" 2>/dev/null; then
      echo "$(date -Iseconds) REVERTED $f (syntax error)" >> "$LOG_DIR/selfmod.log"
      git checkout -- "$f" 2>/dev/null || true
    fi
  done
  # Only commit if something was actually staged
  if \! git diff --cached --quiet 2>/dev/null; then
    git commit -m "auto-snapshot post-session $(date +%Y%m%d_%H%M%S)" --no-gpg-sign 2>/dev/null || true
  fi
fi
# Push to keep remote in sync (best-effort, don't block on failure)
git push origin master 2>/dev/null || true
