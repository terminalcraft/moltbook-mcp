#!/bin/bash
# Session rotation and mode determination for heartbeat.sh
#
# Extracted from heartbeat.sh (R#311). Contains rotation state management,
# mode determination (emergency/override/normal), session context computation,
# and mode transformation pipeline.
#
# Sourced by heartbeat.sh. Expects these globals set by caller:
#   DIR, LOG_DIR, STATE_DIR, DRY_RUN, SAFE_MODE, EMERGENCY_MODE,
#   OVERRIDE_MODE, INIT_DEGRADED, INIT_FAILURES, safe_stage()
#
# Sets: PATTERN, COUNTER, ROT_IDX, RETRY_COUNT, LAST_OUTCOME, MODE_CHAR,
#   R_FOCUS, B_FOCUS, DOWNGRADED, CTX_FILE, CTX_ENV, compute_session_context()

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

# Shared function: run session-context.mjs and source the env output. (R#290)
# Called on initial computation and again after mode downgrade.
compute_session_context() {
  node "$DIR/session-context.mjs" "$MODE_CHAR" "$COUNTER" "$B_FOCUS" > "$CTX_FILE" 2>/dev/null || echo "{}" > "$CTX_FILE"
  if [ -f "$CTX_ENV" ]; then
    source "$CTX_ENV"
  fi
}

if [ -z "$EMERGENCY_MODE" ]; then
  safe_stage "session-context" '
    compute_session_context
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
    compute_session_context
  '
fi
