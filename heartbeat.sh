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

# --- Session rotation (computed before hooks so pre-hooks have context) ---
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
  ESTATE_SESSION=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$ESTATE','utf8')).session||0)}catch{console.log(0)}" 2>/dev/null || echo 0)
  if [ "$ESTATE_SESSION" -gt "$COUNTER" ] 2>/dev/null; then
    COUNTER="$ESTATE_SESSION"
    echo "$COUNTER" > "$SESSION_COUNTER_FILE"
    echo "$(date -Iseconds) synced counter from engagement-state: $COUNTER" >> "$LOG_DIR/selfmod.log"
  fi
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

# R sessions alternate between evolve/maintain focus (added s289, fixed s294, s299).
R_COUNTER_FILE="$STATE_DIR/r_session_counter"
R_FOCUS="evolve"
if [ "$MODE_CHAR" = "R" ]; then
  R_COUNT=0
  [ -f "$R_COUNTER_FILE" ] && R_COUNT=$(cat "$R_COUNTER_FILE")
  R_COUNT=$((R_COUNT + 1))
  echo "$R_COUNT" > "$R_COUNTER_FILE"
  if [ $((R_COUNT % 2)) -eq 0 ]; then
    R_FOCUS="maintain"
  fi
fi

# B sessions alternate between feature/meta focus (mirrors R evolve/maintain).
B_COUNTER_FILE="$STATE_DIR/b_session_counter"
B_FOCUS="feature"
if [ "$MODE_CHAR" = "B" ]; then
  B_COUNT=0
  [ -f "$B_COUNTER_FILE" ] && B_COUNT=$(cat "$B_COUNTER_FILE")
  B_COUNT=$((B_COUNT + 1))
  echo "$B_COUNT" > "$B_COUNTER_FILE"
  if [ $((B_COUNT % 2)) -eq 0 ]; then
    B_FOCUS="meta"
  fi
fi

# --- Outage-aware session skip ---
# If API has been down 5+ consecutive checks, skip every other heartbeat.
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
    fi
  else
    rm -f "$SKIP_FILE"
  fi
else
  rm -f "$SKIP_FILE"
fi

# --- Log rotation ---
# Keep only the 20 most recent session logs. Truncate cron.log if >1MB.
# This runs every heartbeat to prevent unbounded log growth (~2MB/session).
SESSION_LOGS=( $(ls -t "$LOG_DIR"/20*.log 2>/dev/null) )
if [ ${#SESSION_LOGS[@]} -gt 20 ]; then
  for old_log in "${SESSION_LOGS[@]:20}"; do
    rm -f "$old_log"
  done
  echo "$(date -Iseconds) log-rotate: removed $((${#SESSION_LOGS[@]} - 20)) old session logs" >> "$LOG_DIR/selfmod.log"
fi
# Truncate oversized utility logs (cron.log grows ~12MB/day from health checks)
for util_log in "$LOG_DIR/cron.log" "$LOG_DIR/hooks.log" "$LOG_DIR/health.log"; do
  if [ -f "$util_log" ] && [ "$(stat -c%s "$util_log" 2>/dev/null || echo 0)" -gt 1048576 ]; then
    tail -100 "$util_log" > "${util_log}.tmp" && mv "${util_log}.tmp" "$util_log"
    echo "$(date -Iseconds) log-rotate: truncated $(basename "$util_log")" >> "$LOG_DIR/selfmod.log"
  fi
done

# --- Pre-session hooks ---
# Each script in hooks/pre-session/ runs in sort order before the session.
# Hooks receive MODE_CHAR and SESSION_NUM for session-type-aware decisions.
PRE_HOOKS_DIR="$DIR/hooks/pre-session"
if [ -d "$PRE_HOOKS_DIR" ]; then
  for hook in "$PRE_HOOKS_DIR"/*; do
    [ -x "$hook" ] || continue
    echo "$(date -Iseconds) running pre-hook: $(basename "$hook")" >> "$LOG_DIR/hooks.log"
    MODE_CHAR="$MODE_CHAR" SESSION_NUM="$COUNTER" R_FOCUS="$R_FOCUS" B_FOCUS="$B_FOCUS" \
      timeout 30 "$hook" >> "$LOG_DIR/hooks.log" 2>&1 || \
      echo "$(date -Iseconds) pre-hook FAILED: $(basename "$hook")" >> "$LOG_DIR/hooks.log"
  done
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

# Assemble full prompt: base identity + session-specific instructions.
# For R sessions, inject the focus type directly into the prompt (s299).
# Previously R_FOCUS was only in MCP env, invisible to the agent's shell.
B_FOCUS_BLOCK=""
if [ "$MODE_CHAR" = "B" ]; then
  B_FOCUS_BLOCK="

## B Session Focus: ${B_FOCUS}
B_FOCUS=${B_FOCUS} (B session #${B_COUNT}). Follow the **${B_FOCUS}** guidelines below."
fi

R_FOCUS_BLOCK=""
if [ "$MODE_CHAR" = "R" ]; then
  R_FOCUS_BLOCK="

## R Session Focus: ${R_FOCUS}
R_FOCUS=${R_FOCUS} (R session #${R_COUNT}). Follow the **${R_FOCUS}** checklist below."
fi

PROMPT="${BASE_PROMPT}

${MODE_PROMPT}${R_FOCUS_BLOCK}${B_FOCUS_BLOCK}"

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
        "SESSION_NUM": "$COUNTER",
        "R_FOCUS": "$R_FOCUS",
        "B_FOCUS": "$B_FOCUS"
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

# --- Session outcome tracking ---
# Log every session's outcome to a structured outcomes file for diagnostics.
# Format: timestamp mode session_num exit_code outcome duration_seconds
SESSION_END=$(date +%s)
SESSION_START_EPOCH=$(date -d "$(head -1 "$LOG" | grep -oP '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}' || echo '')" +%s 2>/dev/null || echo "$SESSION_END")
DURATION=$((SESSION_END - SESSION_START_EPOCH))

case "$EXIT_CODE" in
  0)   OUTCOME="success" ;;
  124) OUTCOME="timeout" ;;
  *)   OUTCOME="error" ;;
esac

echo "$(date -Iseconds) $MODE_CHAR s=$COUNTER exit=$EXIT_CODE outcome=$OUTCOME dur=${DURATION}s" >> "$LOG_DIR/outcomes.log"

if [ "$EXIT_CODE" -eq 124 ]; then
  echo "$(date -Iseconds) session killed by timeout (15m)" >> "$LOG_DIR/timeouts.log"
elif [ "$EXIT_CODE" -ne 0 ]; then
  echo "$(date -Iseconds) session failed: mode=$MODE_CHAR s=$COUNTER exit=$EXIT_CODE" >> "$LOG_DIR/errors.log"
fi

echo "=== Done $(date -Iseconds) ===" | tee -a "$LOG"

# --- Post-session pipeline ---
# Each step is a script in hooks/post-session/, run in sort order.
# Hooks receive session context including EXIT_CODE and OUTCOME for conditional logic.

HOOKS_DIR="$DIR/hooks/post-session"
if [ -d "$HOOKS_DIR" ]; then
  for hook in "$HOOKS_DIR"/*; do
    [ -x "$hook" ] || continue
    echo "$(date -Iseconds) running hook: $(basename "$hook")" >> "$LOG_DIR/hooks.log"
    MODE_CHAR="$MODE_CHAR" SESSION_NUM="$COUNTER" LOG_FILE="$LOG" R_FOCUS="$R_FOCUS" B_FOCUS="$B_FOCUS" \
      SESSION_EXIT="$EXIT_CODE" SESSION_OUTCOME="$OUTCOME" \
      timeout 60 "$hook" >> "$LOG_DIR/hooks.log" 2>&1 || \
      echo "$(date -Iseconds) hook FAILED: $(basename "$hook")" >> "$LOG_DIR/hooks.log"
  done
fi
