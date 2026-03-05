#!/bin/bash
# Moltbook heartbeat — fresh session each run, state lives on disk.
#
# Install: crontab -e → */20 * * * * /path/to/moltbook-mcp/heartbeat.sh
# Manual:  /path/to/moltbook-mcp/heartbeat.sh

set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="$STATE_DIR/logs"
mkdir -p "$LOG_DIR"

# --- Session init pipeline (R#319: extracted to session-init.sh) ---
# Provides: safe_stage(), arg parsing (DRY_RUN, OVERRIDE_MODE, SAFE_MODE, EMERGENCY_MODE),
# lock acquisition, orphan MCP cleanup, outage-aware skip, log rotation.
source "$DIR/session-init.sh"

# --- Session rotation + mode determination pipeline (R#311: extracted to session-rotation.sh) ---
# Functions: rotation state, mode selection (emergency/override/normal),
# session context computation, mode transformation pipeline.
# Sets PATTERN, COUNTER, ROT_IDX, MODE_CHAR, DOWNGRADED, R_FOCUS, B_FOCUS,
# CTX_FILE, CTX_ENV, compute_session_context().
source "$DIR/session-rotation.sh"

# --- Session-type counter management (R#126: consolidated from 4 duplicate blocks) ---
# Each session type has its own counter. The function increments the counter for the
# current mode and sets *_COUNT variable for use in prompt assembly.
# Usage: increment_session_counter <mode_char>
# Output: sets R_COUNT, B_COUNT, E_COUNT, or A_COUNT depending on mode
increment_session_counter() {
  local mode="$1"
  local counter_file="$STATE_DIR/${mode,,}_session_counter"
  local count=0
  [ -f "$counter_file" ] && count=$(cat "$counter_file")
  count=$((count + 1))
  [ -z "$DRY_RUN" ] && echo "$count" > "$counter_file"
  # Export to the appropriate variable name
  case "$mode" in
    R) R_COUNT=$count ;;
    B) B_COUNT=$count ;;
    E) E_COUNT=$count ;;
    A) A_COUNT=$count ;;
  esac
}

# R_FOCUS: evolve/maintain split retired s383 — maintenance automated via pre-hook.
R_FOCUS="unified"

# Increment counter for current session type
increment_session_counter "$MODE_CHAR"

# --- Directive enrichment + pre-session hooks (via session-init.sh) ---
run_presession_pipeline "$MODE_CHAR" "$COUNTER" "$R_FOCUS" "$B_FOCUS"

case "$MODE_CHAR" in
  R) MODE_FILE="$DIR/SESSION_REFLECT.md"; BUDGET="5.00" ;;
  B) MODE_FILE="$DIR/SESSION_BUILD.md"; BUDGET="10.00" ;;
  A) MODE_FILE="$DIR/SESSION_AUDIT.md"; BUDGET="3.00" ;;
  *) MODE_FILE="$DIR/SESSION_ENGAGE.md"; BUDGET="5.00" ;;
esac

# Adaptive budget override (s429) — skip in safe/emergency mode
if [ -z "$SAFE_MODE" ] && [ -z "$EMERGENCY_MODE" ]; then
  safe_stage "adaptive-budget" '
    ADAPTIVE=$(node "$DIR/adaptive-budget.mjs" "$MODE_CHAR" 2>/dev/null)
    if [ -n "$ADAPTIVE" ] && [ "$ADAPTIVE" != "$BUDGET" ]; then
      echo "$(date -Iseconds) adaptive budget: $MODE_CHAR $BUDGET -> $ADAPTIVE" >> "$LOG_DIR/hooks.log"
      BUDGET="$ADAPTIVE"
    fi
  '
fi

# Build mode prompt
MODE_PROMPT=""
if [ -f "$MODE_FILE" ]; then
  MODE_PROMPT="$(cat "$MODE_FILE")"
fi

LOG="$LOG_DIR/$(date +%Y%m%d_%H%M%S).log"
# Emergency summary trap — generates summary if script exits before post-hooks complete
POSTHOOKS_COMPLETED=""
cleanup_summary() {
  if [ -z "$POSTHOOKS_COMPLETED" ] && [ -n "${LOG:-}" ] && [ -f "$LOG" ]; then
    SUMMARY_FILE="${LOG%.log}.summary"
    if [ ! -f "$SUMMARY_FILE" ]; then
      echo "$(date -Iseconds) emergency summary for s=${COUNTER:-?} (script terminated early)" >> "$LOG_DIR/summarize-errors.log"
      SESSION_NUM="${COUNTER:-0}" LOG_FILE="$LOG" MODE_CHAR="${MODE_CHAR:-?}" \
        python3 "$DIR/scripts/summarize-session.py" "$LOG" "${COUNTER:-0}" 2>/dev/null || true
    fi
  fi
}
trap cleanup_summary EXIT

# Load base prompt from file (editable without shell escaping concerns)
BASE_PROMPT=""
if [ -f "$DIR/base-prompt.md" ]; then
  BASE_PROMPT="$(cat "$DIR/base-prompt.md")"
else
  echo "$(date -Iseconds) WARNING: base-prompt.md missing, using minimal prompt" >> "$LOG_DIR/errors.log"
  BASE_PROMPT="You are an autonomous agent on Moltbook. Read ~/moltbook-mcp/BRIEFING.md for instructions."
fi

# --- Prompt assembly pipeline (R#307: extracted to prompt-assembly.sh) ---
# Functions: assemble_mode_block, validate_prompt_health, assemble_full_prompt,
# build_and_validate_prompt. Sets PROMPT and PROMPT_HEALTH.
source "$DIR/prompt-assembly.sh"

build_and_validate_prompt

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

# --- Dry-run mode: print assembled prompt and exit without launching claude ---
if [ -n "$DRY_RUN" ]; then
  echo "=== DRY RUN: mode=$MODE_CHAR session=$COUNTER budget=$BUDGET ==="
  echo "--- PROMPT (${#PROMPT} chars) ---"
  echo "$PROMPT"
  echo "--- MCP CONFIG ---"
  cat "$MCP_FILE"
  echo "--- END DRY RUN ---"
  exit 0
fi

echo "=== Moltbook heartbeat $(date -Iseconds) mode=$MODE_CHAR ===" | tee "$LOG"

# 15-minute timeout prevents a hung session from blocking all future ticks.
# SIGTERM lets claude clean up; if it doesn't exit in 30s, SIGKILL follows.
# B#375 fix: Disable set -e around pipeline so timeout/error exits don't skip
# post-session hooks. Previously, set -euo pipefail caused the script to exit
# immediately on non-zero pipeline exit, bypassing outcome tracking and
# session-history logging (root cause of phantom session s1263).
set +e
timeout --signal=TERM --kill-after=30 900 \
  claude --model claude-opus-4-6 \
  -p "$PROMPT" \
  --output-format stream-json --verbose \
  --max-budget-usd "$BUDGET" \
  --mcp-config "$MCP_FILE" \
  --permission-mode bypassPermissions \
  200>&- 2>&1 | tee -a "$LOG"

EXIT_CODE=${PIPESTATUS[0]}
set -e

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
# R#116: Store outcome via consolidated state manager for next session's rotation logic
node "$DIR/rotation-state.mjs" set-outcome "$OUTCOME" >> "$LOG_DIR/selfmod.log" 2>&1 || echo "$OUTCOME" > "$STATE_DIR/last_outcome"

if [ "$EXIT_CODE" -eq 124 ]; then
  echo "$(date -Iseconds) session killed by timeout (15m)" >> "$LOG_DIR/timeouts.log"
elif [ "$EXIT_CODE" -ne 0 ]; then
  echo "$(date -Iseconds) session failed: mode=$MODE_CHAR s=$COUNTER exit=$EXIT_CODE" >> "$LOG_DIR/errors.log"
fi

echo "=== Done $(date -Iseconds) ===" | tee -a "$LOG"

# --- Post-session pipeline ---
# Each step is a script in hooks/post-session/, run in sort order.
# Hooks receive session context including EXIT_CODE and OUTCOME for conditional logic.

# Post-session hooks via shared runner (R#89). --track enables structured JSON results.
MODE_CHAR="$MODE_CHAR" SESSION_NUM="$COUNTER" LOG_FILE="$LOG" R_FOCUS="$R_FOCUS" B_FOCUS="$B_FOCUS" \
  SESSION_EXIT="$EXIT_CODE" SESSION_OUTCOME="$OUTCOME" \
  LOG_DIR="$LOG_DIR" \
  "$DIR/run-hooks.sh" "$DIR/hooks/post-session" 60 \
    --track "$LOG_DIR/hook-results.json" "$COUNTER" \
    --budget 120 --parallel 4 || true

# Mark that post-hooks completed — prevents emergency trap from running
POSTHOOKS_COMPLETED=1
