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

# --- Stage isolation helper ---
# Wraps each init stage so failures log + use defaults instead of crashing.
# Usage: safe_stage "stage_name" default_action <<< "commands"
# Returns 0 always. Sets INIT_DEGRADED=1 if any stage failed.
INIT_DEGRADED=""
INIT_FAILURES=""
safe_stage() {
  local stage_name="$1"
  shift
  if eval "$@" 2>>"$LOG_DIR/init-errors.log"; then
    return 0
  else
    local exit_code=$?
    INIT_DEGRADED=1
    INIT_FAILURES="${INIT_FAILURES:+$INIT_FAILURES, }$stage_name"
    echo "$(date -Iseconds) [init] stage '$stage_name' failed (exit $exit_code), using defaults" >> "$LOG_DIR/init-errors.log"
    return 0
  fi
}

# Accept optional flags: mode override (E, B, R), --dry-run, --safe-mode, --emergency
DRY_RUN=""
OVERRIDE_MODE=""
SAFE_MODE=""
EMERGENCY_MODE=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --safe-mode) SAFE_MODE=1 ;;
    --emergency) EMERGENCY_MODE=1 ;;
    E|B|R) OVERRIDE_MODE="$arg" ;;
  esac
done

# Kill orphan MCP node processes from previous crashed sessions
if [ -z "$DRY_RUN" ]; then
  pkill -f "node $DIR/index.js" 2>/dev/null || true
  sleep 1
fi

LOCKFILE="$STATE_DIR/heartbeat.lock"
if [ -z "$DRY_RUN" ]; then
  exec 200>"$LOCKFILE"
  if ! flock -n 200; then
    echo "$(date -Iseconds) heartbeat already running, skipping" >> "$LOG_DIR/skipped.log"
    exit 0
  fi
fi

# --- Session rotation via consolidated state manager (R#116) ---
# Single source of truth: rotation-state.mjs manages session_counter, rotation_index,
# retry_count, and last_outcome in one JSON file. Legacy files still written for
# backward compatibility during migration.
ROTATION_FILE="$DIR/rotation.conf"

# Read pattern (default BBBRE)
PATTERN="BBBRE"
if [ -f "$ROTATION_FILE" ]; then
  PAT_LINE=$(grep '^PATTERN=' "$ROTATION_FILE" | tail -1)
  if [ -n "$PAT_LINE" ]; then
    PATTERN="${PAT_LINE#PATTERN=}"
  fi
fi

# Defaults in case rotation stage fails
COUNTER="${COUNTER:-1}"
ROT_IDX="${ROT_IDX:-0}"
RETRY_COUNT="${RETRY_COUNT:-0}"
LAST_OUTCOME="${LAST_OUTCOME:-success}"
MODE_CHAR="${MODE_CHAR:-B}"

if [ -n "$EMERGENCY_MODE" ]; then
  # Emergency: skip rotation entirely, use defaults
  MODE_CHAR="B"
  echo "$(date -Iseconds) [init] emergency mode: skipping rotation, defaulting to B" >> "$LOG_DIR/init-errors.log"
elif [ -n "$OVERRIDE_MODE" ]; then
  MODE_CHAR="$OVERRIDE_MODE"
  # Override mode: increment counter only (no rotation logic)
  safe_stage "rotation-override" \
    'COUNTER=$(node "$DIR/rotation-state.mjs" increment-counter 2>/dev/null || echo "1")'
else
  # Normal rotation: read current state, apply retry logic, advance
  safe_stage "rotation" '
    if [ -z "$DRY_RUN" ]; then
      ROTATION_OUTPUT=$(node "$DIR/rotation-state.mjs" advance --shell)
      eval "$(echo "$ROTATION_OUTPUT" | grep "^[A-Z_]*=")"
    else
      ROTATION_OUTPUT=$(node "$DIR/rotation-state.mjs" read --shell)
      eval "$(echo "$ROTATION_OUTPUT" | grep "^[A-Z_]*=")"
    fi
  '
  # Now COUNTER, ROT_IDX, RETRY_COUNT, LAST_OUTCOME are set from rotation-state.mjs

  # Determine mode from rotation index
  PAT_LEN=${#PATTERN}
  IDX=$((ROT_IDX % PAT_LEN))
  MODE_CHAR="${PATTERN:$IDX:1}"
fi

# R_FOCUS must be defaulted before context computation (set fully later).
R_FOCUS=${R_FOCUS:-evolve}
B_FOCUS="feature"  # Legacy — kept for hook compatibility but no longer alternates.

# --- Single-pass context computation ---
# Replaces 7+ inline `node -e` invocations with one script. (R#47, s487)
CTX_FILE="$STATE_DIR/session-context.json"
CTX_ENV="$STATE_DIR/session-context.env"

if [ -z "$EMERGENCY_MODE" ]; then
  safe_stage "session-context" '
    node "$DIR/session-context.mjs" "$MODE_CHAR" "$COUNTER" "$B_FOCUS" > "$CTX_FILE" 2>/dev/null || echo "{}" > "$CTX_FILE"
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
  '
fi

# --- Mode transformation pipeline (R#106) ---
# Replaces hardcoded downgrade gates with a hook-based system.
# Each script in hooks/mode-transform/ can propose a mode change.
# Scripts receive: MODE_CHAR, COUNTER, CTX_* env vars.
# Output format: "NEW_MODE reason" (e.g., "B engagement platforms degraded")
# First valid transformation wins. This makes mode logic extensible.
DOWNGRADED=""
TRANSFORM_DIR="$DIR/hooks/mode-transform"

if [ -z "$SAFE_MODE" ] && [ -z "$EMERGENCY_MODE" ] && [ -d "$TRANSFORM_DIR" ] && [ -z "$OVERRIDE_MODE" ]; then
  safe_stage "mode-transform" '
    for script in "$TRANSFORM_DIR"/*.sh; do
      [ -f "$script" ] || continue
      RESULT=$(MODE_CHAR="$MODE_CHAR" COUNTER="$COUNTER" \
        CTX_PENDING_COUNT="${CTX_PENDING_COUNT:-0}" \
        CTX_WQ_FALLBACK="${CTX_WQ_FALLBACK:-}" \
        bash "$script" 2>/dev/null || true)
      if [ -n "$RESULT" ]; then
        NEW_MODE="${RESULT%% *}"
        REASON="${RESULT#* }"
        if [ "$NEW_MODE" != "$MODE_CHAR" ] && [[ "$NEW_MODE" =~ ^[EBRA]$ ]]; then
          echo "$(date -Iseconds) mode-transform: $MODE_CHAR→$NEW_MODE ($REASON) via $(basename "$script")" >> "$LOG_DIR/selfmod.log"
          DOWNGRADED="$MODE_CHAR→$NEW_MODE"
          MODE_CHAR="$NEW_MODE"
          break
        fi
      fi
    done
  '
fi

# Recompute session context after downgrade so prompt blocks match actual mode. (R#59)
if [ -n "$DOWNGRADED" ]; then
  safe_stage "context-recompute" '
    echo "$(date -Iseconds) recomputing session-context for downgrade: $DOWNGRADED → $MODE_CHAR" >> "$LOG_DIR/selfmod.log"
    node "$DIR/session-context.mjs" "$MODE_CHAR" "$COUNTER" "$B_FOCUS" > "$CTX_FILE" 2>/dev/null || echo "{}" > "$CTX_FILE"
    if [ -f "$CTX_ENV" ]; then
      source "$CTX_ENV"
    fi
  '
fi

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

# --- Outage-aware session skip ---
# If API has been down 5+ consecutive checks, skip every other heartbeat.
# Skip this check in safe/emergency mode — we want to try regardless.
if [ -z "$SAFE_MODE" ] && [ -z "$EMERGENCY_MODE" ]; then
  safe_stage "outage-check" '
    SKIP_FILE="$STATE_DIR/outage_skip_toggle"
    API_STATUS=$(node "$DIR/health-check.cjs" --status 2>&1 || true)
    if echo "$API_STATUS" | grep -q "^DOWN" ; then
      DOWN_COUNT=$(echo "$API_STATUS" | grep -oP "down \K[0-9]+")
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
  '
fi

# --- Log rotation (non-critical, never abort on failure) ---
safe_stage "log-rotation" '
  SESSION_LOGS=( $(ls -t "$LOG_DIR"/20*.log 2>/dev/null) )
  if [ ${#SESSION_LOGS[@]} -gt 20 ]; then
    for old_log in "${SESSION_LOGS[@]:20}"; do
      rm -f "$old_log"
    done
    echo "$(date -Iseconds) log-rotate: removed $((${#SESSION_LOGS[@]} - 20)) old session logs" >> "$LOG_DIR/selfmod.log"
  fi
  for util_log in "$LOG_DIR/cron.log" "$LOG_DIR/hooks.log" "$LOG_DIR/health.log"; do
    if [ -f "$util_log" ] && [ "$(stat -c%s "$util_log" 2>/dev/null || echo 0)" -gt 1048576 ]; then
      tail -100 "$util_log" > "${util_log}.tmp" && mv "${util_log}.tmp" "$util_log"
      echo "$(date -Iseconds) log-rotate: truncated $(basename "$util_log")" >> "$LOG_DIR/selfmod.log"
    fi
  done
'

# --- Directive enrichment + pre-session hooks (skipped in safe/emergency mode) ---
if [ -z "$DRY_RUN" ] && [ -z "$SAFE_MODE" ] && [ -z "$EMERGENCY_MODE" ]; then
  safe_stage "directive-enrichment" \
    'python3 "$DIR/scripts/directive-enrichment.py" "$DIR/directives.json" "$DIR/work-queue.json" "$STATE_DIR/directive-enrichment.json" 2>/dev/null'

  safe_stage "pre-session-hooks" '
    MODE_CHAR="$MODE_CHAR" SESSION_NUM="$COUNTER" R_FOCUS="$R_FOCUS" B_FOCUS="$B_FOCUS" \
      LOG_DIR="$LOG_DIR" \
      DIRECTIVE_ENRICHMENT="$STATE_DIR/directive-enrichment.json" \
      "$DIR/run-hooks.sh" "$DIR/hooks/pre-session" 30 \
        --track "$LOG_DIR/pre-hook-results.json" "$COUNTER" \
        --budget 90 --parallel 4
  '
fi

case "$MODE_CHAR" in
  R) MODE_FILE="$DIR/SESSION_REFLECT.md"; BUDGET="5.00" ;;
  B) MODE_FILE="$DIR/SESSION_BUILD.md"; BUDGET="10.00" ;;
  A) MODE_FILE="$DIR/SESSION_AUDIT.md"; BUDGET="3.00" ;;
  *) MODE_FILE="$DIR/SESSION_ENGAGE.md"; BUDGET="5.00" ;;
esac

# Adaptive budget override (s429) — skip in safe/emergency mode
if [ -z "$SAFE_MODE" ] && [ -z "$EMERGENCY_MODE" ]; then
  safe_stage "adaptive-budget" '
    ADAPTIVE=$(python3 "$DIR/adaptive-budget.py" "$MODE_CHAR" 2>/dev/null)
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
  WQ_FALLBACK="${CTX_WQ_FALLBACK:-}"
  if [ -n "$WQ_ITEM" ] && [ "$WQ_FALLBACK" = "true" ]; then
    WQ_BLOCK="

## YOUR ASSIGNED TASK (from brainstorming fallback — queue was empty):
${WQ_ITEM}

The work queue is empty. This idea was pulled from BRAINSTORMING.md. First, create a proper work-queue item for it (node work-queue.js add), then build it. Also add 2+ more queue items from brainstorming or new ideas to prevent future starvation."
  elif [ -n "$WQ_ITEM" ]; then
    WQ_BLOCK="

## YOUR ASSIGNED TASK (from work queue):
${WQ_ITEM}

This is your primary task for this session. Complete it before picking up anything else. If blocked, explain why in your session log.${WQ_WARNING}"
  fi

  # wq-368: Surface configured capabilities so B sessions know what tools exist
  CAP_LINE=""
  if [ -n "${CTX_CAPABILITY_SUMMARY:-}" ]; then
    CAP_LINE="
Capabilities: ${CTX_CAPABILITY_SUMMARY}. Live: ${CTX_LIVE_PLATFORMS:-none}."
    if [ -n "${CTX_CRED_MISSING:-}" ]; then
      CAP_LINE="${CAP_LINE}
WARN: Missing credential files: ${CTX_CRED_MISSING}"
    fi
  fi

  # wq-374: EVM balance dashboard for onchain tasks
  EVM_LINE=""
  if [ -n "${CTX_EVM_BALANCE_SUMMARY:-}" ]; then
    EVM_LINE="
EVM wallet (Base): ${CTX_EVM_BALANCE_SUMMARY}. Onchain tasks: ${CTX_ONCHAIN_ITEMS:-none}."
  elif [ -n "${CTX_EVM_BALANCE_ERROR:-}" ]; then
    EVM_LINE="
EVM balance check failed: ${CTX_EVM_BALANCE_ERROR}"
  fi

  B_FOCUS_BLOCK="

## B Session: #${B_COUNT}${CAP_LINE}${EVM_LINE}${WQ_BLOCK}"
fi

# E session prompt block: fully assembled by session-context.mjs (R#93).
# Moved manual e-session-context.md + eval target assembly into JS pre-computation,
# mirroring how R sessions consume CTX_R_PROMPT_BLOCK.
E_CONTEXT_BLOCK=""
if [ "$MODE_CHAR" = "E" ]; then
  E_CONTEXT_BLOCK="

${CTX_E_PROMPT_BLOCK:-## E Session
Follow SESSION_ENGAGE.md.}"
fi

# R session prompt block: fully assembled by session-context.mjs (R#52).
# Moved 40 lines of bash string-building into JS where the data already lives.
R_FOCUS_BLOCK=""
if [ "$MODE_CHAR" = "R" ]; then
  R_FOCUS_BLOCK="

${CTX_R_PROMPT_BLOCK:-## R Session
Follow the checklist in SESSION_REFLECT.md.}"
fi

# A session prompt block: fully assembled by session-context.mjs (R#102).
# Audit sessions now get pre-computed context like R/E sessions: previous audit findings,
# audit-tagged queue items status, and cost trend data.
A_CONTEXT_BLOCK=""
if [ "$MODE_CHAR" = "A" ]; then
  A_CONTEXT_BLOCK="

${CTX_A_PROMPT_BLOCK:-## A Session
Follow the checklist in SESSION_AUDIT.md.}"
fi

# --- Prompt inject blocks (R#120: extracted to prompt-inject-processor.mjs) ---
# Manifest-driven injection with dependency resolution, usage tracking.
INJECT_BLOCKS=""
if [ -z "$EMERGENCY_MODE" ]; then
  safe_stage "prompt-inject" '
    INJECT_RESULT=$(PROJECT_DIR="$DIR" node "$DIR/prompt-inject-processor.mjs" "$MODE_CHAR" "$COUNTER" 2>/dev/null || echo "{\"blocks\":\"\"}")
    INJECT_BLOCKS=$(echo "$INJECT_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get(\"blocks\",\"\"))" 2>/dev/null || echo "")
  '
fi

# Build degradation notice if any init stages failed
DEGRADED_NOTICE=""
if [ -n "$INIT_DEGRADED" ]; then
  DEGRADED_NOTICE="

## INIT DEGRADATION NOTICE
Some initialization stages failed and used defaults: ${INIT_FAILURES}.
This session may have incomplete context. Check ~/moltbook-mcp/logs/init-errors.log for details.
Do NOT attempt to fix heartbeat.sh or init scripts — the human operator handles this."
fi

PROMPT="${BASE_PROMPT}

${MODE_PROMPT}${R_FOCUS_BLOCK}${B_FOCUS_BLOCK}${E_CONTEXT_BLOCK}${A_CONTEXT_BLOCK}${INJECT_BLOCKS}${DEGRADED_NOTICE}"

# --- Prompt health gate (R#239, refactored R#255) ---
# Validates the assembled prompt has expected content for the session type.
# Catches silent session-context.mjs failures that produce empty prompt blocks,
# which historically lead to zero-output sessions (e.g. s1408).
#
# validate_prompt_blocks: shared validation for initial check + post-retry.
# Sets PROMPT_HEALTH and PROMPT_WARNINGS. $1 = label prefix for warnings.
validate_prompt_blocks() {
  local label="${1:-}"
  PROMPT_HEALTH="OK"
  PROMPT_WARNINGS=""
  local plen=${#PROMPT}
  if [ "$plen" -lt 2000 ]; then
    PROMPT_HEALTH="DEGRADED"
    PROMPT_WARNINGS="prompt too short (${plen} chars, min 2000)"
  fi
  case "$MODE_CHAR" in
    R) [ -n "$R_FOCUS_BLOCK" ] && [ ${#R_FOCUS_BLOCK} -ge 100 ] || { PROMPT_HEALTH="DEGRADED"; PROMPT_WARNINGS="${PROMPT_WARNINGS:+$PROMPT_WARNINGS; }R prompt block ${label}(${#R_FOCUS_BLOCK} chars)"; } ;;
    B) [ -n "$B_FOCUS_BLOCK" ] && [ ${#B_FOCUS_BLOCK} -ge 50 ] || { PROMPT_HEALTH="DEGRADED"; PROMPT_WARNINGS="${PROMPT_WARNINGS:+$PROMPT_WARNINGS; }B prompt block ${label}(${#B_FOCUS_BLOCK} chars)"; } ;;
    E) [ -n "$E_CONTEXT_BLOCK" ] && [ ${#E_CONTEXT_BLOCK} -ge 100 ] || { PROMPT_HEALTH="DEGRADED"; PROMPT_WARNINGS="${PROMPT_WARNINGS:+$PROMPT_WARNINGS; }E prompt block ${label}(${#E_CONTEXT_BLOCK} chars)"; } ;;
    A) [ -n "$A_CONTEXT_BLOCK" ] && [ ${#A_CONTEXT_BLOCK} -ge 100 ] || { PROMPT_HEALTH="DEGRADED"; PROMPT_WARNINGS="${PROMPT_WARNINGS:+$PROMPT_WARNINGS; }A prompt block ${label}(${#A_CONTEXT_BLOCK} chars)"; } ;;
  esac
}

# reassemble_prompt: rebuild full prompt from current block variables.
reassemble_prompt() {
  PROMPT="${BASE_PROMPT}

${MODE_PROMPT}${R_FOCUS_BLOCK}${B_FOCUS_BLOCK}${E_CONTEXT_BLOCK}${A_CONTEXT_BLOCK}${INJECT_BLOCKS}${DEGRADED_NOTICE}"
}

validate_prompt_blocks "missing or too short "

if [ "$PROMPT_HEALTH" = "DEGRADED" ] && [ -z "$EMERGENCY_MODE" ] && [ -z "$SAFE_MODE" ]; then
  echo "$(date -Iseconds) [prompt-health] DEGRADED (attempt 1): $PROMPT_WARNINGS — retrying session-context" >> "$LOG_DIR/init-errors.log"

  # --- Prompt health retry (R#247) ---
  # When session-context produces insufficient prompt blocks, retry once.
  # This closes a feedback loop: previously degraded context was detected but not
  # corrected, leading to recurring zero-output sessions (s1408, s1425, s1441).
  RETRY_CTX=$(node "$DIR/session-context.mjs" "$MODE_CHAR" "$COUNTER" "$B_FOCUS" 2>/dev/null || echo "{}")
  echo "$RETRY_CTX" > "$CTX_FILE"
  if [ -f "$CTX_ENV" ]; then
    source "$CTX_ENV"
  fi

  # Re-assemble the failed prompt block from fresh context
  case "$MODE_CHAR" in
    R)
      R_FOCUS_BLOCK="

${CTX_R_PROMPT_BLOCK:-## R Session
Follow the checklist in SESSION_REFLECT.md.}"
      ;;
    E)
      E_CONTEXT_BLOCK="

${CTX_E_PROMPT_BLOCK:-## E Session
Follow SESSION_ENGAGE.md.}"
      ;;
    A)
      A_CONTEXT_BLOCK="

${CTX_A_PROMPT_BLOCK:-## A Session
Follow the checklist in SESSION_AUDIT.md.}"
      ;;
  esac

  reassemble_prompt
  validate_prompt_blocks "still too short after retry "

  if [ "$PROMPT_HEALTH" = "OK" ]; then
    echo "$(date -Iseconds) [prompt-health] RECOVERED after retry" >> "$LOG_DIR/init-errors.log"
  fi
fi

if [ "$PROMPT_HEALTH" = "DEGRADED" ]; then
  echo "$(date -Iseconds) [prompt-health] DEGRADED (final): $PROMPT_WARNINGS" >> "$LOG_DIR/init-errors.log"
  # Inject warning into the prompt so the agent knows its context is incomplete
  PROMPT="${PROMPT}

## PROMPT HEALTH WARNING
Prompt assembly produced incomplete context: ${PROMPT_WARNINGS}.
Session-context computation may have failed silently. Proceed with caution — check state files manually if needed."
fi

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
