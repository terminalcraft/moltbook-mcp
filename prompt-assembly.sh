#!/bin/bash
# Prompt assembly pipeline for heartbeat.sh
#
# Extracted from heartbeat.sh (R#307). Contains the prompt block assembly,
# health validation, and build+validate pipeline.
#
# Sourced by heartbeat.sh. Expects these globals set by caller:
#   DIR, LOG_DIR, CTX_FILE, CTX_ENV, MODE_CHAR, COUNTER, B_FOCUS,
#   BASE_PROMPT, MODE_PROMPT, EMERGENCY_MODE, SAFE_MODE,
#   INIT_DEGRADED, INIT_FAILURES, safe_stage()
#
# Sets: PROMPT, PROMPT_HEALTH

# --- Prompt block assembly (R#267: consolidated from 4 duplicate per-mode blocks) ---
# Each mode has a CTX_*_PROMPT_BLOCK env var set by session-context.mjs.
# This table-driven approach replaces 4 separate if-blocks + a duplicate retry case.
# MODE_BLOCK holds the assembled context block for the current session type.
declare -A MODE_CTX_VAR=(
  [R]="CTX_R_PROMPT_BLOCK" [B]="CTX_B_PROMPT_BLOCK"
  [E]="CTX_E_PROMPT_BLOCK" [A]="CTX_A_PROMPT_BLOCK"
)
declare -A MODE_FALLBACK=(
  [R]="## R Session
Follow the checklist in SESSION_REFLECT.md."
  [B]="## B Session
Follow SESSION_BUILD.md."
  [E]="## E Session
Follow SESSION_ENGAGE.md."
  [A]="## A Session
Follow the checklist in SESSION_AUDIT.md."
)
# Minimum block size for health validation (B is smaller due to simpler context)
declare -A MODE_MIN_BLOCK=( [R]=100 [B]=50 [E]=100 [A]=100 )

# assemble_mode_block: reads CTX var for current mode, falls back to default.
# Sets MODE_BLOCK. Call after session-context.mjs populates CTX_ENV.
assemble_mode_block() {
  local ctx_var="${MODE_CTX_VAR[$MODE_CHAR]:-}"
  local fallback="${MODE_FALLBACK[$MODE_CHAR]:-}"
  local ctx_val="${!ctx_var:-}"
  MODE_BLOCK="

${ctx_val:-$fallback}"
}

# --- Prompt health validation (R#301: extracted from duplicated inline blocks) ---
# Checks prompt length and mode block size. Sets PROMPT_HEALTH and PROMPT_WARNINGS.
# Caller must have PROMPT, MODE_BLOCK, and MODE_CHAR set.
validate_prompt_health() {
  local min_block="${MODE_MIN_BLOCK[$MODE_CHAR]:-100}"
  PROMPT_HEALTH="OK"
  PROMPT_WARNINGS=""
  if [ ${#PROMPT} -lt 2000 ]; then
    PROMPT_HEALTH="DEGRADED"
    PROMPT_WARNINGS="prompt too short (${#PROMPT} chars, min 2000)"
  fi
  if [ -z "$MODE_BLOCK" ] || [ ${#MODE_BLOCK} -lt "$min_block" ]; then
    PROMPT_HEALTH="DEGRADED"
    PROMPT_WARNINGS="${PROMPT_WARNINGS:+$PROMPT_WARNINGS; }${MODE_CHAR} prompt block missing or too short (${#MODE_BLOCK} chars, min ${min_block})"
  fi
}

# Assembles full prompt from components. Requires MODE_BLOCK, INJECT_BLOCKS, DEGRADED_NOTICE.
assemble_full_prompt() {
  PROMPT="${BASE_PROMPT}

${MODE_PROMPT}${MODE_BLOCK}${INJECT_BLOCKS}${DEGRADED_NOTICE}"
}

# --- Prompt build + validate pipeline (R#296, R#301) ---
# Assembles prompt inject blocks, degradation notice, and full prompt.
# Validates health. If degraded, retries session-context once then appends warning.
# Sets PROMPT (ready for claude invocation) and PROMPT_HEALTH.
build_and_validate_prompt() {
  # Prompt inject blocks (R#120: extracted to prompt-inject-processor.mjs)
  INJECT_BLOCKS=""
  if [ -z "$EMERGENCY_MODE" ]; then
    safe_stage "prompt-inject" '
      INJECT_RESULT=$(PROJECT_DIR="$DIR" node "$DIR/prompt-inject-processor.mjs" "$MODE_CHAR" "$COUNTER" 2>/dev/null || echo "{\"blocks\":\"\"}")
      INJECT_BLOCKS=$(echo "$INJECT_RESULT" | jq -r '"'"'.blocks // ""'"'"' 2>/dev/null || echo "")
    '
  fi

  # Degradation notice for failed init stages
  DEGRADED_NOTICE=""
  if [ -n "$INIT_DEGRADED" ]; then
    DEGRADED_NOTICE="

## INIT DEGRADATION NOTICE
Some initialization stages failed and used defaults: ${INIT_FAILURES}.
This session may have incomplete context. Check ~/moltbook-mcp/logs/init-errors.log for details.
Do NOT attempt to fix heartbeat.sh or init scripts — the human operator handles this."
  fi

  # Assemble mode block + full prompt, then validate
  assemble_mode_block
  assemble_full_prompt
  validate_prompt_health

  # Retry once if degraded (re-run session-context, re-assemble, re-validate)
  if [ "$PROMPT_HEALTH" = "DEGRADED" ] && [ -z "$EMERGENCY_MODE" ] && [ -z "$SAFE_MODE" ]; then
    echo "$(date -Iseconds) [prompt-health] DEGRADED (attempt 1): $PROMPT_WARNINGS — retrying session-context" >> "$LOG_DIR/init-errors.log"
    node "$DIR/session-context.mjs" "$MODE_CHAR" "$COUNTER" "$B_FOCUS" > "$CTX_FILE" 2>/dev/null || echo "{}" > "$CTX_FILE"
    [ -f "$CTX_ENV" ] && source "$CTX_ENV"
    assemble_mode_block
    assemble_full_prompt
    validate_prompt_health
    if [ "$PROMPT_HEALTH" = "OK" ]; then
      echo "$(date -Iseconds) [prompt-health] RECOVERED after retry" >> "$LOG_DIR/init-errors.log"
    fi
  fi

  # Append warning if still degraded
  if [ "$PROMPT_HEALTH" = "DEGRADED" ]; then
    echo "$(date -Iseconds) [prompt-health] DEGRADED (final): $PROMPT_WARNINGS" >> "$LOG_DIR/init-errors.log"
    PROMPT="${PROMPT}

## PROMPT HEALTH WARNING
Prompt assembly produced incomplete context: ${PROMPT_WARNINGS}.
Session-context computation may have failed silently. Proceed with caution — check state files manually if needed."
  fi
}
