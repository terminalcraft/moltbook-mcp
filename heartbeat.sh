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

# --- Pre-session hooks ---
# Each script in hooks/pre-session/ runs in sort order before the session.
# To add a new pre-session step: drop an executable script in hooks/pre-session/.
PRE_HOOKS_DIR="$DIR/hooks/pre-session"
if [ -d "$PRE_HOOKS_DIR" ]; then
  for hook in "$PRE_HOOKS_DIR"/*; do
    [ -x "$hook" ] || continue
    echo "$(date -Iseconds) running pre-hook: $(basename "$hook")" >> "$LOG_DIR/hooks.log"
    timeout 30 "$hook" >> "$LOG_DIR/hooks.log" 2>&1 || \
      echo "$(date -Iseconds) pre-hook FAILED: $(basename "$hook")" >> "$LOG_DIR/hooks.log"
  done
fi

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

# Sync counter with engagement-state.json (authoritative source).
# The counter file can drift if reset/wiped. Always use the higher value.
ESTATE="$HOME/.config/moltbook/engagement-state.json"
if [ -f "$ESTATE" ]; then
  ESTATE_SESSION=$(python3 -c "import json; print(json.load(open('$ESTATE')).get('session',0))" 2>/dev/null || echo 0)
  if [ "$ESTATE_SESSION" -gt "$COUNTER" ] 2>/dev/null; then
    COUNTER="$ESTATE_SESSION"
    echo "$COUNTER" > "$SESSION_COUNTER_FILE"
    echo "$(date -Iseconds) synced counter from engagement-state: $COUNTER" >> "$LOG_DIR/selfmod.log"
  fi

  # Prune engagement-state arrays to prevent unbounded growth (added s288).
  # Keep most recent 200 entries in seen/voted arrays.
  python3 -c "
import json
with open('$ESTATE') as f: d = json.load(f)
changed = False
for key in ('seen', 'voted'):
    arr = d.get(key, [])
    if len(arr) > 200:
        d[key] = arr[-200:]
        changed = True
if changed:
    with open('$ESTATE', 'w') as f: json.dump(d, f, indent=2)
" 2>/dev/null || true
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

  # Increment counter and update variable to match (so summarizer gets correct value)
  COUNTER=$((COUNTER + 1))
  echo "$COUNTER" > "$SESSION_COUNTER_FILE"
fi

# Engagement health gate: if E session but no platforms are writable, downgrade to B.
# This prevents wasting budget on "scan all broken platforms" sessions.
if [ "$MODE_CHAR" = "E" ] && [ -z "$OVERRIDE_MODE" ]; then
  ENGAGE_STATUS=$(node "$DIR/engagement-health.cjs" 2>/dev/null | tail -1 || echo "ENGAGE_DEGRADED")
  if [ "$ENGAGE_STATUS" = "ENGAGE_DEGRADED" ]; then
    echo "$(date -Iseconds) engage→build downgrade: all engagement platforms degraded" >> "$LOG_DIR/selfmod.log"
    MODE_CHAR="B"
  fi
fi

case "$MODE_CHAR" in
  R) MODE_FILE="$DIR/SESSION_REFLECT.md"; BUDGET="5.00" ;;
  B) MODE_FILE="$DIR/SESSION_BUILD.md"; BUDGET="10.00" ;;
  *) MODE_FILE="$DIR/SESSION_ENGAGE.md"; BUDGET="5.00" ;;
esac

# R sessions alternate between evolve/maintain focus (added s289).
# Simple: use session counter parity. Odd=evolve, even=maintain.
R_FOCUS="evolve"
if [ "$MODE_CHAR" = "R" ] && [ $((COUNTER % 2)) -eq 0 ]; then
  R_FOCUS="maintain"
fi

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
        "SESSION_TYPE": "$MODE_CHAR",
        "R_FOCUS": "$R_FOCUS"
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

# --- Post-session pipeline ---
# Each step is a script in hooks/post-session/, run in sort order.
# This replaces inline post-session logic with an extensible hook system.
# To add a new post-session step: drop a script in hooks/post-session/.

HOOKS_DIR="$DIR/hooks/post-session"
if [ -d "$HOOKS_DIR" ]; then
  for hook in "$HOOKS_DIR"/*; do
    [ -x "$hook" ] || continue
    echo "$(date -Iseconds) running hook: $(basename "$hook")" >> "$LOG_DIR/hooks.log"
    MODE_CHAR="$MODE_CHAR" SESSION_NUM="$COUNTER" LOG_FILE="$LOG" \
      timeout 60 "$hook" >> "$LOG_DIR/hooks.log" 2>&1 || \
      echo "$(date -Iseconds) hook FAILED: $(basename "$hook")" >> "$LOG_DIR/hooks.log"
  done
fi
