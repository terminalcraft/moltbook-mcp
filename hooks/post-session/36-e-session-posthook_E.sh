#!/bin/bash
# 36-e-session-posthook_E.sh — Consolidated E-session post-hook dispatcher
#
# Merges 7 individual E-session hooks into a single dispatcher that parses
# shared JSON files once and runs all checks sequentially. Reduces hook count
# and eliminates repeated JSON parsing overhead.
#
# Replaces:
#   36-intel-checkpoint_E.sh   (wq-399, wq-416, wq-425, wq-430)
#   37-d049-enforcement_E.sh   (wq-375, wq-416, wq-425, wq-430)
#   38-early-exit_E.sh         (wq-423, wq-428)
#   39-note-fallback_E.sh      (wq-451)
#   40-trace-fallback_E.sh     (wq-550)
#   41-quality-audit_E.sh      (wq-624, d066)
#   42-quality-enforce_E.sh    (wq-632, d066)
#   37-scope-bleed-detect_E.sh (wq-712) — merged B#483 (wq-727)
#   24-engagement-audit.sh     (wq-745) — merged B#495 (wq-745)
#
# Created: B#459 (wq-662)
set -euo pipefail

: "${SESSION_NUM:?SESSION_NUM required}"
: "${MODE_CHAR:?MODE_CHAR required}"

export SESSION="$SESSION_NUM"
export STATE_DIR="$HOME/.config/moltbook"
export LOG_DIR="$STATE_DIR/logs"
MCP_DIR="$(dirname "$(dirname "$(dirname "$(realpath "$0")")")")"

export INTEL_FILE="$STATE_DIR/engagement-intel.json"
export TRACE_FILE="$STATE_DIR/engagement-trace.json"
export TIMING_FILE="$STATE_DIR/e-phase-timing.json"
export HISTORY_FILE="$STATE_DIR/session-history.txt"
export TRACKING_FILE="$MCP_DIR/e-phase35-tracking.json"
export NUDGE_FILE="$STATE_DIR/d049-nudge.txt"
export QUALITY_SCORES="$LOG_DIR/quality-scores.jsonl"
export ENFORCE_FILE="$LOG_DIR/quality-enforcement.jsonl"

mkdir -p "$LOG_DIR"

###############################################################################
# Phase 1: Parse shared JSON files ONCE — store in temp file for safe access
###############################################################################

export PARSED_FILE=$(mktemp)
trap 'rm -f "$PARSED_FILE"' EXIT

# Parse all JSON files via extracted module (R#302: moved from 220-line heredoc).
# All subprocess calls use node (d071 python3 elimination complete as of B#505, s1691).
PARSER_SCRIPT="$(dirname "$(realpath "$0")")/../lib/e-posthook-parser.mjs"
PARSE_OUTPUT=$(node "$PARSER_SCRIPT" 2>/dev/null)

if [[ -z "$PARSE_OUTPUT" ]]; then
  echo "e-posthook: CRITICAL — parse phase failed"
  exit 1
fi

# Split output: JSON goes to PARSED_FILE, shell vars get eval'd
echo "$PARSE_OUTPUT" | sed -n 's/^JSON://p' > "$PARSED_FILE"
SHELL_VARS=$(echo "$PARSE_OUTPUT" | sed -n 's/^VARS://p')

if [[ ! -s "$PARSED_FILE" ]] || [[ -z "$SHELL_VARS" ]]; then
  echo "e-posthook: CRITICAL — parse output incomplete"
  exit 1
fi

# Safe eval: only accept lines matching KEY=value pattern (per d061 rule)
eval "$(echo "$SHELL_VARS" | grep '^[A-Z_]*=')"

# Defaults for variables that may be missing if extraction produced partial output
: "${INTEL_COUNT:=0}"
: "${HAS_TRACE:=false}"
: "${PHASE2_REACHED:=false}"
: "${IS_RATE_LIMITED:=false}"
: "${ALL_PLATFORMS_FAILED:=false}"
: "${FAILURE_MODE:=unknown}"
: "${PLATFORM_DETAILS:=}"
: "${TOTAL_SECONDS:=-1}"
: "${DURATION_STR:=}"
: "${CURRENT_NOTE:=}"
: "${E_COUNT:=0}"
: "${Q_FAILS:=0}"
: "${Q_WARNS:=0}"
: "${Q_TOTAL:=0}"
: "${ARCHIVE_INTEL_COUNT:=0}"
: "${BACKUP_SUBSTITUTION_COUNT:=0}"

D049_COMPLIANT="false"
[[ "$INTEL_COUNT" -gt 0 ]] && D049_COMPLIANT="true"

###############################################################################
# Check 1: Intel checkpoint (was 36-intel-checkpoint_E.sh)
#   Last-resort safety net — writes minimal intel when session has 0 entries
###############################################################################
check_intel_checkpoint() {
  if [[ "$INTEL_COUNT" -gt 0 ]]; then
    echo "intel-checkpoint: s$SESSION has $INTEL_COUNT entries, no action needed"
    return 0
  fi

  # Determine if we should write a checkpoint
  local action="skip" reason="no_phase2" details="Session never reached Phase 2"

  if [[ "$IS_RATE_LIMITED" == "true" ]]; then
    action="write"; reason="rate_limit"; details="Session hit API rate limit before any engagement"
  elif [[ "$PHASE2_REACHED" == "true" && "$PLATFORM_DETAILS" == ALL_FAILED* ]]; then
    action="write"; reason="platform_unavailable"; details="$PLATFORM_DETAILS"
  elif [[ "$PHASE2_REACHED" == "true" ]]; then
    if [[ -n "$PLATFORM_DETAILS" ]]; then
      reason="partial_engagement"; details="Phase 2 reached but intel not captured ($PLATFORM_DETAILS)"
    else
      reason="truncated"; details="Phase 2 reached but intel not captured"
    fi
    action="write"
  fi

  if [[ "$action" != "write" ]]; then
    echo "intel-checkpoint: s$SESSION skipped ($reason: $details)"
    return 0
  fi

  # Write checkpoint entry — uses PARSED_FILE for trace_intel_data
  INTEL_REASON="$reason" INTEL_DETAILS="$details" node << 'CHECKPOINT_JS' 2>/dev/null || echo "intel-checkpoint: failed to write recovery entry"
const fs = require('fs');
const path = require('path');

const intelFile = process.env.INTEL_FILE;
const session = parseInt(process.env.SESSION);
const reason = process.env.INTEL_REASON;
const details = process.env.INTEL_DETAILS;
const parsedFile = process.env.PARSED_FILE;

const parsed = JSON.parse(fs.readFileSync(parsedFile, 'utf8'));
const traceIntel = parsed.trace_intel_data;

const entry = traceIntel || {
  type: 'pattern',
  source: 'post-session checkpoint (' + reason + ')',
  summary: 'E session s' + session + ' completed with 0 intel. Reason: ' + reason + '. ' + details,
  actionable: 'Review s' + session + ' failure (' + reason + ') and capture intel from next E session',
  session,
  checkpoint: true,
  failure_reason: reason
};

fs.mkdirSync(path.dirname(intelFile), { recursive: true });
fs.writeFileSync(intelFile, JSON.stringify([entry], null, 2) + '\n');

const sourceLabel = traceIntel ? 'trace-extracted' : reason;
console.log('intel-checkpoint: wrote ' + sourceLabel + ' recovery entry for s' + session);
CHECKPOINT_JS

  echo "$(date -Iseconds) intel-checkpoint: s=$SESSION reason=$reason details=$details" >> "$LOG_DIR/intel-checkpoint.log"
}

###############################################################################
# Check 2: d049 enforcement (was 37-d049-enforcement_E.sh)
#   Records compliance, writes nudge for next E session if violated
###############################################################################
check_d049_enforcement() {
  echo "$(date -Iseconds) d049-enforcement: s=$SESSION intel_count=$INTEL_COUNT compliant=$D049_COMPLIANT failure_mode=$FAILURE_MODE" >> "$LOG_DIR/d049-enforcement.log"

  # Update e-phase35-tracking.json (extracted to d049-tracking-update.mjs, R#308)
  TRACKING_UPDATE_SCRIPT="$(dirname "$(realpath "$0")")/../lib/d049-tracking-update.mjs"
  node "$TRACKING_UPDATE_SCRIPT" 2>/dev/null || echo "d049-enforcement: failed to update tracking"

  # Write or clear nudge
  if [[ "$D049_COMPLIANT" == "false" ]]; then
    if [[ "$FAILURE_MODE" == "rate_limit" ]]; then
      echo "d049-enforcement: s$SESSION was rate-limited (uncontrollable), no nudge written"
    elif [[ "$FAILURE_MODE" == "truncated_early" ]]; then
      echo "d049-enforcement: s$SESSION truncated before Phase 2 (uncontrollable), no nudge written"
    elif [[ "$FAILURE_MODE" == "trace_without_intel" ]]; then
      cat > "$NUDGE_FILE" << NUDGE_EOF
## d049 WARNING: trace_without_intel (from post-session hook)

Previous E session (s$SESSION) wrote an engagement trace but captured 0 intel entries.
The session completed Phase 3a (trace) but ended before Phase 3b (intel capture).

**PREVENTION**: Call \`node e-intel-checkpoint.mjs <platform> "<summary>"\` after your
FIRST platform interaction in Phase 2. This is your safety net — don't rely on
reaching Phase 3b to capture intel.

**ALSO**: Write intel entries to engagement-intel.json IMMEDIATELY after writing
your engagement trace in Phase 3a. Don't separate trace and intel with other operations.
NUDGE_EOF
      echo "d049-enforcement: trace_without_intel nudge written for next E session (s$SESSION)"
    else
      cat > "$NUDGE_FILE" << NUDGE_EOF
## d049 VIOLATION ALERT (from post-session hook)

Previous E session (s$SESSION) completed with 0 intel entries.
Failure mode: $FAILURE_MODE
This is a violation of d049 (minimum 1 intel entry per E session).

**YOU MUST capture at least 1 intel entry this session.**

Do this IMMEDIATELY after your first platform engagement (Phase 2), not at the end.
Don't wait for Phase 3b — capture intel as you go:
- After each platform interaction, note one actionable observation
- Write it to engagement-intel.json BEFORE moving to the next platform

If you reach Phase 3a without any intel entries, STOP and go back to capture intel.
NUDGE_EOF
      echo "d049-enforcement: nudge written for next E session (violation in s$SESSION, mode=$FAILURE_MODE)"
    fi
  else
    rm -f "$NUDGE_FILE"
    echo "d049-enforcement: compliant, nudge cleared"
  fi
}

###############################################################################
# Check 3: Early exit detection (was 38-early-exit_E.sh)
#   Flags sessions <120s and injects stigmergic pressure into trace
###############################################################################
check_early_exit() {
  if [[ "$TOTAL_SECONDS" -lt 0 ]]; then
    return  # No duration info available
  fi

  if [[ "$TOTAL_SECONDS" -ge 120 ]]; then
    return  # Not an early exit
  fi

  echo "$(date -Iseconds) s=$SESSION dur=${DURATION_STR} (${TOTAL_SECONDS}s) — early exit detected" >> "$LOG_DIR/e-early-exits.log"

  # Stigmergic pressure: inject follow_up into engagement-trace.json
  # Logic extracted to hooks/lib/e-posthook-early-exit.mjs (R#335)
  local EARLY_EXIT_SCRIPT
  EARLY_EXIT_SCRIPT="$(dirname "$(realpath "$0")")/../lib/e-posthook-early-exit.mjs"
  node "$EARLY_EXIT_SCRIPT" 2>/dev/null || echo "early-exit: failed to inject stigmergic pressure (non-fatal)"
}

###############################################################################
# Check 4: Note fallback (was 39-note-fallback_E.sh)
#   Replaces truncated session-history notes with trace-derived summaries
#   Logic extracted to hooks/lib/note-fallback.mjs (R#316)
###############################################################################
check_note_fallback() {
  local NOTE_FALLBACK_SCRIPT
  NOTE_FALLBACK_SCRIPT="$(dirname "$(realpath "$0")")/../lib/note-fallback.mjs"
  node "$NOTE_FALLBACK_SCRIPT" 2>/dev/null || echo "note-fallback: script error (non-fatal)"
}

###############################################################################
# Check 5: Trace fallback (was 40-trace-fallback_E.sh)
#   Generates synthetic trace from intel when session truncated before Phase 3a
###############################################################################
check_trace_fallback() {
  [[ "$HAS_TRACE" == "true" ]] && return 0  # Trace exists, nothing to do

  [[ "$ARCHIVE_INTEL_COUNT" -gt 0 ]] || {
    echo "trace-fallback: s$SESSION has no intel entries, skipping"
    return 0
  }

  # Generate minimal trace from intel
  # Logic extracted to hooks/lib/e-posthook-trace-fallback.mjs (R#335)
  local TRACE_FALLBACK_SCRIPT
  TRACE_FALLBACK_SCRIPT="$(dirname "$(realpath "$0")")/../lib/e-posthook-trace-fallback.mjs"
  node "$TRACE_FALLBACK_SCRIPT" 2>/dev/null || echo "trace-fallback: failed to generate synthetic trace (non-fatal)"
}

###############################################################################
# Check 6: Quality audit (was 41-quality-audit_E.sh)
#   Appends follow_up to trace when quality violations found
###############################################################################
check_quality_audit() {
  echo "quality-audit: s$SESSION — $Q_TOTAL posts checked, $Q_FAILS fails, $Q_WARNS warns"

  # Run quality audit + credential-diversity check (wq-913)
  # Script handles both Q_FAILS > 0 (quality gate) and CURRENT_NOTE credential scanning
  if [[ -f "$TRACE_FILE" ]]; then
    local QUALITY_AUDIT_SCRIPT
    QUALITY_AUDIT_SCRIPT="$(dirname "$(realpath "$0")")/../lib/e-posthook-quality-audit.mjs"
    CURRENT_NOTE="$CURRENT_NOTE" node "$QUALITY_AUDIT_SCRIPT" 2>/dev/null || echo "quality-audit: failed to run quality audit (non-fatal)"
  fi
}

###############################################################################
# Check 7: Quality enforcement (was 42-quality-enforce_E.sh)
#   Calculates rolling quality metrics and writes enforcement record
#   Logic extracted to hooks/lib/quality-enforce.mjs (R#312)
###############################################################################
check_quality_enforce() {
  local ENFORCE_SCRIPT
  ENFORCE_SCRIPT="$(dirname "$(realpath "$0")")/../lib/quality-enforce.mjs"
  node "$ENFORCE_SCRIPT" 2>/dev/null || echo "quality-enforce: script error (non-fatal)"
}

###############################################################################
# Check 8: E session cost cap (wq-719, wq-890, wq-894)
#   Warn when E session cost exceeds $1.80 soft cap
#   Track 1-registration-per-session limit via trace keywords
#   Also enforces 6-minute exit gate — logs violations for audit
#   Logic extracted to hooks/lib/e-cost-cap.mjs (R#321)
###############################################################################
check_e_cost_cap() {
  local COST_CAP_SCRIPT
  COST_CAP_SCRIPT="$(dirname "$(realpath "$0")")/../lib/e-cost-cap.mjs"
  E_COST_THRESHOLD="${E_COST_THRESHOLD:-1.80}" node "$COST_CAP_SCRIPT" 2>/dev/null || echo "e-cost-cap: script error (non-fatal)"

  # Duration gate enforcement (wq-894, wq-897): warn if E session exceeded 5 minutes
  if [[ "$TOTAL_SECONDS" -gt 300 ]]; then
    local OVER_MIN=$(( (TOTAL_SECONDS - 300) / 60 ))
    echo "e-cost-cap: WARN — s${SESSION} duration ${DURATION_STR} exceeded 5-minute exit gate by ~${OVER_MIN}m"
    echo "$(date -Iseconds) DURATION-GATE WARN: E session s${SESSION} ran ${DURATION_STR} (${TOTAL_SECONDS}s > 300s gate)" >> "${LOG_DIR}/hooks.log"
  fi
}

###############################################################################
# Check 9: Scope bleed detection (was 37-scope-bleed-detect_E.sh, wq-712)
#   Warn if build commits were made during E session (scope violation)
###############################################################################
check_scope_bleed() {
  cd "$MCP_DIR" || return 0
  local RECENT_COMMITS
  RECENT_COMMITS=$(git log --oneline --since="15 minutes ago" 2>/dev/null | grep -cv "auto-snapshot" || true)
  if [ "$RECENT_COMMITS" -gt 0 ]; then
    local COMMIT_LIST
    COMMIT_LIST=$(git log --oneline --since="15 minutes ago" 2>/dev/null | grep -v "auto-snapshot" | head -5)
    echo "$(date -Iseconds) SCOPE-BLEED WARNING: E session s${SESSION} has ${RECENT_COMMITS} build commit(s):" >> "${LOG_DIR}/hooks.log"
    echo "$COMMIT_LIST" >> "${LOG_DIR}/hooks.log"
    echo "scope-bleed: WARN — E session s${SESSION} made ${RECENT_COMMITS} code commit(s)"
  fi
}

###############################################################################
# Check 10: Engagement logging audit (was 24-engagement-audit.sh, wq-745)
#   Flags E sessions that didn't use log_engagement MCP tool
###############################################################################
check_engagement_logging() {
  local LOG_FILE="${LOG_FILE:-}"
  [ -f "$LOG_FILE" ] || return 0

  local COUNT
  COUNT=$(grep -c '"log_engagement"' "$LOG_FILE" 2>/dev/null || echo 0)

  if [ "$COUNT" -eq 0 ]; then
    local NUDGE="$STATE_DIR/engagement-audit-nudge.txt"
    cat > "$NUDGE" << MSG
## Engagement logging alert
Last E session (s${SESSION}) made 0 log_engagement calls. Every post, comment, reply, and upvote must be logged using the log_engagement MCP tool. This data feeds the monitoring dashboard. Call log_engagement immediately after each interaction.
MSG
    echo "engagement-audit: 0 log_engagement calls in E session"
  else
    rm -f "$STATE_DIR/engagement-audit-nudge.txt"
    echo "engagement-audit: $COUNT log_engagement calls — ok"
  fi
}

###############################################################################
# Phase 2: Run all checks sequentially
###############################################################################

check_intel_checkpoint || true
check_d049_enforcement || true
check_early_exit || true
check_note_fallback || true
check_trace_fallback || true
check_quality_audit || true
check_quality_enforce || true
check_e_cost_cap || true
check_scope_bleed || true
check_engagement_logging || true

exit 0
