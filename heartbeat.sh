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

# Counter sync with engagement-state moved to session-context.mjs (R#47)

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

  # Rotation index tracks position in the BBRE pattern independently of session counter.
  # On failure (timeout/error), the rotation index does NOT advance — same mode retries.
  # On success, rotation advances. This prevents crashes from skipping session types.
  ROTATION_IDX_FILE="$STATE_DIR/rotation_index"
  LAST_OUTCOME_FILE="$STATE_DIR/last_outcome"

  ROT_IDX=0
  [ -f "$ROTATION_IDX_FILE" ] && ROT_IDX=$(cat "$ROTATION_IDX_FILE")

  # Check if last session failed — if so, don't advance rotation
  if [ -f "$LAST_OUTCOME_FILE" ]; then
    LAST_OUTCOME=$(cat "$LAST_OUTCOME_FILE")
    if [ "$LAST_OUTCOME" = "success" ]; then
      ROT_IDX=$((ROT_IDX + 1))
    else
      echo "$(date -Iseconds) retry: last session outcome=$LAST_OUTCOME, repeating rotation slot" >> "$LOG_DIR/selfmod.log"
    fi
  else
    # First run or file missing — advance normally
    ROT_IDX=$((ROT_IDX + 1))
  fi
  echo "$ROT_IDX" > "$ROTATION_IDX_FILE"

  PAT_LEN=${#PATTERN}
  IDX=$((ROT_IDX % PAT_LEN))
  MODE_CHAR="${PATTERN:$IDX:1}"

  # Session counter always increments for unique numbering
  COUNTER=$((COUNTER + 1))
  echo "$COUNTER" > "$SESSION_COUNTER_FILE"
fi

# R_FOCUS must be defaulted before context computation (set fully later).
R_FOCUS=${R_FOCUS:-evolve}
B_FOCUS="feature"  # Legacy — kept for hook compatibility but no longer alternates.
# --- Single-pass context computation ---
# Replaces 7+ inline `node -e` invocations with one script. (R#47, s487)
CTX_FILE="$STATE_DIR/session-context.json"
CTX_ENV="$STATE_DIR/session-context.env"
node "$DIR/session-context.mjs" "$MODE_CHAR" "$COUNTER" "$B_FOCUS" > "$CTX_FILE" 2>/dev/null || echo '{}' > "$CTX_FILE"

# Source shell-compatible context — eliminates 11+ per-field node spawns. (R#50)
# All fields available as CTX_<FIELD> (e.g. CTX_PENDING_COUNT, CTX_WQ_ITEM).
if [ -f "$CTX_ENV" ]; then
  source "$CTX_ENV"
fi

# Sync counter with engagement-state (from session-context.mjs)
ESTATE_SESSION="${CTX_ESTATE_SESSION:-0}"
if [ "$ESTATE_SESSION" -gt "$COUNTER" ] 2>/dev/null; then
  COUNTER="$ESTATE_SESSION"
  echo "$COUNTER" > "$SESSION_COUNTER_FILE"
  echo "$(date -Iseconds) synced counter from engagement-state: $COUNTER" >> "$LOG_DIR/selfmod.log"
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

# Queue starvation gate: if B session but queue is empty, downgrade to R.
# Threshold lowered from <2 to <1 in s479 (R#43): <2 caused cascading R downgrades.
# With BBRE rotation, R sessions replenish every 4th session. B should run whenever
# there's ANY pending work, not wait for 2+ items.
if [ "$MODE_CHAR" = "B" ] && [ -z "$OVERRIDE_MODE" ]; then
  PENDING_COUNT="${CTX_PENDING_COUNT:-0}"
  if [ "$PENDING_COUNT" -lt 1 ]; then
    echo "$(date -Iseconds) build→reflect downgrade: only $PENDING_COUNT pending queue items" >> "$LOG_DIR/selfmod.log"
    MODE_CHAR="R"
  fi
fi

# R session counter (evolve/maintain split retired s383 — maintenance automated via pre-hook).
R_COUNTER_FILE="$STATE_DIR/r_session_counter"
R_FOCUS="unified"
if [ "$MODE_CHAR" = "R" ]; then
  R_COUNT=0
  [ -f "$R_COUNTER_FILE" ] && R_COUNT=$(cat "$R_COUNTER_FILE")
  R_COUNT=$((R_COUNT + 1))
  echo "$R_COUNT" > "$R_COUNTER_FILE"
fi

# B session counter (feature/meta alternation retired R#49 — meta tags unused).
B_COUNTER_FILE="$STATE_DIR/b_session_counter"
if [ "$MODE_CHAR" = "B" ]; then
  B_COUNT=0
  [ -f "$B_COUNTER_FILE" ] && B_COUNT=$(cat "$B_COUNTER_FILE")
  B_COUNT=$((B_COUNT + 1))
  echo "$B_COUNT" > "$B_COUNTER_FILE"
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

# Adaptive budget override (s429)
ADAPTIVE=$(python3 "$DIR/adaptive-budget.py" "$MODE_CHAR" 2>/dev/null)
if [ -n "$ADAPTIVE" ] && [ "$ADAPTIVE" != "$BUDGET" ]; then
  echo "$(date -Iseconds) adaptive budget: $MODE_CHAR $BUDGET -> $ADAPTIVE" >> "$LOG_DIR/hooks.log"
  BUDGET="$ADAPTIVE"
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

# Assemble full prompt: base identity + session-specific instructions.
# For R sessions, inject the focus type directly into the prompt (s299).
# Previously R_FOCUS was only in MCP env, invisible to the agent's shell.
B_FOCUS_BLOCK=""
if [ "$MODE_CHAR" = "B" ]; then
  # Auto-unblock + task extraction handled by session-context.mjs (R#47)
  WQ_ITEM="${CTX_WQ_ITEM:-}"

  WQ_BLOCK=""
  WQ_DEPTH="${CTX_PENDING_COUNT:-0}"
  WQ_WARNING=""
  if [ "$WQ_DEPTH" -le 1 ] 2>/dev/null; then
    WQ_WARNING="
WARNING: Work queue is nearly empty (${WQ_DEPTH} items). After completing your task, consider adding new items from BRAINSTORMING.md or generating new ideas."
  fi
  if [ -n "$WQ_ITEM" ]; then
    WQ_BLOCK="

## YOUR ASSIGNED TASK (from work queue):
${WQ_ITEM}

This is your primary task for this session. Complete it before picking up anything else. If blocked, explain why in your session log.${WQ_WARNING}"
  fi

  B_FOCUS_BLOCK="

## B Session: #${B_COUNT}${WQ_BLOCK}"
fi

E_CONTEXT_BLOCK=""
if [ "$MODE_CHAR" = "E" ]; then
  E_CONTEXT_FILE="$STATE_DIR/e-session-context.md"
  if [ -f "$E_CONTEXT_FILE" ]; then
    E_CONTEXT_BLOCK="

## Previous engagement context (auto-generated)
$(cat "$E_CONTEXT_FILE")"
  fi

  # Eval target from session-context.mjs (R#47)
  EVAL_TARGET="${CTX_EVAL_TARGET:-}"
  if [ -n "$EVAL_TARGET" ]; then
    E_CONTEXT_BLOCK="${E_CONTEXT_BLOCK}

## YOUR DEEP-DIVE TARGET (from services.json):
${EVAL_TARGET}

Spend 3-5 minutes actually exploring this service. Read content, sign up if possible, interact if alive, reject if dead. See SESSION_ENGAGE.md Deep dive section."
  fi
fi

# R session prompt block: fully assembled by session-context.mjs (R#52).
# Moved 40 lines of bash string-building into JS where the data already lives.
R_FOCUS_BLOCK=""
if [ "$MODE_CHAR" = "R" ]; then
  R_FOCUS_BLOCK="

${CTX_R_PROMPT_BLOCK:-## R Session
Follow the checklist in SESSION_REFLECT.md.}"
fi

# Compliance nudge: inject directive-tracking feedback into the session prompt.
# Pre-hook 39-compliance-nudge.sh writes this file when directives are being missed.
COMPLIANCE_BLOCK=""
COMPLIANCE_FILE="$STATE_DIR/compliance-nudge.txt"
if [ -f "$COMPLIANCE_FILE" ]; then
  COMPLIANCE_BLOCK="

$(cat "$COMPLIANCE_FILE")"
fi

PROMPT="${BASE_PROMPT}

${MODE_PROMPT}${R_FOCUS_BLOCK}${B_FOCUS_BLOCK}${E_CONTEXT_BLOCK}${COMPLIANCE_BLOCK}"

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
echo "$OUTCOME" > "$STATE_DIR/last_outcome"

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
HOOK_RESULTS_FILE="$LOG_DIR/hook-results.json"
if [ -d "$HOOKS_DIR" ]; then
  HOOK_PASS=0
  HOOK_FAIL=0
  HOOK_DETAILS=""
  for hook in "$HOOKS_DIR"/*; do
    [ -x "$hook" ] || continue
    HOOK_NAME="$(basename "$hook")"
    HOOK_START=$(date +%s%N)
    echo "$(date -Iseconds) running hook: $HOOK_NAME" >> "$LOG_DIR/hooks.log"
    HOOK_EXIT=0
    MODE_CHAR="$MODE_CHAR" SESSION_NUM="$COUNTER" LOG_FILE="$LOG" R_FOCUS="$R_FOCUS" B_FOCUS="$B_FOCUS" \
      SESSION_EXIT="$EXIT_CODE" SESSION_OUTCOME="$OUTCOME" \
      timeout 60 "$hook" >> "$LOG_DIR/hooks.log" 2>&1 || HOOK_EXIT=$?
    HOOK_END=$(date +%s%N)
    HOOK_DUR_MS=$(( (HOOK_END - HOOK_START) / 1000000 ))
    if [ "$HOOK_EXIT" -eq 0 ]; then
      HOOK_PASS=$((HOOK_PASS + 1))
      HOOK_STATUS="ok"
    else
      HOOK_FAIL=$((HOOK_FAIL + 1))
      HOOK_STATUS="fail:$HOOK_EXIT"
      echo "$(date -Iseconds) hook FAILED: $HOOK_NAME (exit=$HOOK_EXIT, ${HOOK_DUR_MS}ms)" >> "$LOG_DIR/hooks.log"
    fi
    [ -n "$HOOK_DETAILS" ] && HOOK_DETAILS="$HOOK_DETAILS,"
    HOOK_DETAILS="$HOOK_DETAILS{\"hook\":\"$HOOK_NAME\",\"status\":\"$HOOK_STATUS\",\"ms\":$HOOK_DUR_MS}"
  done
  # Write structured results
  echo "{\"session\":$COUNTER,\"ts\":\"$(date -Iseconds)\",\"pass\":$HOOK_PASS,\"fail\":$HOOK_FAIL,\"hooks\":[$HOOK_DETAILS]}" >> "$HOOK_RESULTS_FILE"
  # Keep last 200 entries
  if [ -f "$HOOK_RESULTS_FILE" ] && [ "$(wc -l < "$HOOK_RESULTS_FILE")" -gt 200 ]; then
    tail -200 "$HOOK_RESULTS_FILE" > "$HOOK_RESULTS_FILE.tmp" && mv "$HOOK_RESULTS_FILE.tmp" "$HOOK_RESULTS_FILE"
  fi
fi
