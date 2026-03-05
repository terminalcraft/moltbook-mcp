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
  node -e "
const fs = require('fs');
const traceFile = '$TRACE_FILE';
const session = parseInt('$SESSION');
const duration = '$DURATION_STR';
const totalS = parseInt('$TOTAL_SECONDS');

let traces;
try {
  const raw = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
  traces = Array.isArray(raw) ? raw : (typeof raw === 'object' ? [raw] : []);
} catch { traces = []; }

const warning = 'EARLY EXIT WARNING: Previous E session (s' + session + ') exited in ' + duration + ' (' + totalS + 's). Ensure deeper engagement — check platform health first, then commit to full Phase 2 loop.';

if (traces.length > 0) {
  const latest = traces[traces.length - 1];
  const followUps = latest.follow_ups || [];
  followUps.push(warning);
  latest.follow_ups = followUps;
  latest.early_exit_flag = true;
} else {
  traces.push({
    session, date: new Date().toISOString().slice(0, 10),
    early_exit_flag: true, follow_ups: [warning],
    note: 'Synthetic trace from early-exit hook. Session s' + session + ' lasted ' + duration + '.'
  });
}

fs.writeFileSync(traceFile, JSON.stringify(traces, null, 2) + '\n');
console.log('early-exit: stigmergic pressure injected into trace for s' + session);
" 2>/dev/null || echo "early-exit: failed to inject stigmergic pressure (non-fatal)"
}

###############################################################################
# Check 4: Note fallback (was 39-note-fallback_E.sh)
#   Replaces truncated session-history notes with trace-derived summaries
###############################################################################
check_note_fallback() {
  [[ -f "$HISTORY_FILE" ]] || return 0
  [[ -f "$TRACE_FILE" ]] || return 0
  [[ -n "$CURRENT_NOTE" ]] || return 0

  # Check if note looks like a proper completion line
  if echo "$CURRENT_NOTE" | grep -qiE '^Session [A-Z]#[0-9]+.*complete'; then
    return 0  # Note is fine
  fi

  # Accept substantive notes (>60 chars with platform mentions)
  if [[ "${#CURRENT_NOTE}" -gt 60 ]] && echo "$CURRENT_NOTE" | grep -qiE 'engag|platform|chatr|moltbook|4claw|aicq|clawball|lobchan|pinchwork|colony'; then
    return 0  # Substantive enough
  fi

  # Note is truncated — generate from trace
  [[ "$HAS_TRACE" == "true" ]] || return 0

  GENERATED_NOTE=$(node -e "
const fs = require('fs');
const parsed = JSON.parse(fs.readFileSync('$PARSED_FILE', 'utf8'));
const session = parseInt('$SESSION');
const platforms = (parsed.trace_platforms_engaged || []).map(p => typeof p === 'string' ? p : (p && p.platform ? p.platform : String(p)));
const agents = parsed.trace_agents || [];
const topics = parsed.trace_topics || [];
const eNum = parsed.e_count || '?';

const parts = [];
if (platforms.length) parts.push('Engaged ' + platforms.join(', '));
if (agents.length) parts.push('interacted with ' + agents.slice(0, 3).join(', '));
if (topics.length) parts.push(topics[0]);

let summary = parts.length ? parts.join('; ') : 'engagement session completed';
if (summary.length > 150) summary = summary.slice(0, 147) + '...';

console.log('Session E#' + eNum + ' (s' + session + ') complete. ' + summary + '.');
" 2>/dev/null) || return 0

  [[ -n "$GENERATED_NOTE" ]] || return 0

  # Replace truncated note in session-history.txt
  GENERATED_NOTE="$GENERATED_NOTE" node << 'NOTEFALLBACK_JS' 2>/dev/null || echo "note-fallback: failed to rewrite history (non-fatal)"
const fs = require('fs');
const historyFile = process.env.HISTORY_FILE;
const sessionNum = process.env.SESSION;
const newNote = process.env.GENERATED_NOTE;

const lines = fs.readFileSync(historyFile, 'utf8').split('\n');
const marker = 's=' + sessionNum + ' ';
const newLines = lines.map(line => {
  if (line.includes(marker) && line.includes('note: ')) {
    const idx = line.indexOf('note: ') + 'note: '.length;
    return line.slice(0, idx) + newNote;
  }
  return line;
});

fs.writeFileSync(historyFile, newLines.join('\n'));
console.log('note-fallback: replaced truncated note for s' + sessionNum);
NOTEFALLBACK_JS
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
  node -e "
const fs = require('fs');
const session = parseInt('$SESSION');
const traceFile = '$TRACE_FILE';
const parsed = JSON.parse(fs.readFileSync('$PARSED_FILE', 'utf8'));
const platforms = parsed.archive_intel_platforms || [];
const topics = parsed.archive_intel_topics || [];

const traceEntry = {
  session, date: new Date().toISOString().slice(0, 10),
  picker_mandate: [], platforms_engaged: platforms,
  skipped_platforms: [], topics, agents_interacted: [],
  threads_contributed: [], follow_ups: [],
  _synthetic: true, _source: 'trace-fallback (36-e-session-posthook_E.sh)',
  _reason: 'Session s' + session + ' truncated before Phase 3a trace write'
};

let traces;
try {
  const raw = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
  traces = Array.isArray(raw) ? raw : (typeof raw === 'object' ? [raw] : []);
} catch { traces = []; }

traces.push(traceEntry);
if (traces.length > 30) traces = traces.slice(-30);

fs.writeFileSync(traceFile, JSON.stringify(traces, null, 2) + '\n');
console.log('trace-fallback: generated synthetic trace for s' + session + ' from ' + platforms.length + ' platforms');
" 2>/dev/null || echo "trace-fallback: failed to generate synthetic trace (non-fatal)"
}

###############################################################################
# Check 6: Quality audit (was 41-quality-audit_E.sh)
#   Appends follow_up to trace when quality violations found
###############################################################################
check_quality_audit() {
  if [[ "$Q_TOTAL" -eq 0 ]]; then
    echo "quality-audit: s$SESSION had no quality-checked posts"
    return 0
  fi

  echo "quality-audit: s$SESSION — $Q_TOTAL posts checked, $Q_FAILS fails, $Q_WARNS warns"

  if [[ "$Q_FAILS" -gt 0 ]] && [[ -f "$TRACE_FILE" ]]; then
    node -e "
const fs = require('fs');
const session = parseInt('$SESSION');
const failCount = parseInt('$Q_FAILS');
const total = parseInt('$Q_TOTAL');
const traceFile = '$TRACE_FILE';

let traces;
try {
  const raw = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
  traces = Array.isArray(raw) ? raw : (typeof raw === 'object' ? [raw] : []);
} catch { traces = []; }

for (let i = traces.length - 1; i >= 0; i--) {
  if (traces[i].session === session) {
    if (!traces[i].follow_ups) traces[i].follow_ups = [];
    traces[i].follow_ups.push({
      type: 'quality_warning',
      message: 's' + session + ' quality gate: ' + failCount + '/' + total + ' posts FAILED quality review. Review violations in quality-scores.jsonl and avoid repeating flagged patterns.',
      severity: failCount > 1 ? 'high' : 'medium',
      source: '36-e-session-posthook_E.sh'
    });
    break;
  }
}

fs.writeFileSync(traceFile, JSON.stringify(traces, null, 2) + '\n');
console.log('quality-audit: appended follow_up to trace for s' + session);
" 2>/dev/null || echo "quality-audit: failed to append follow_up (non-fatal)"
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
# Check 8: E session cost cap (wq-719)
#   Warn when E session cost exceeds $2.50
#   Track 1-registration-per-session limit via trace keywords
###############################################################################
E_COST_THRESHOLD="2.50"

check_e_cost_cap() {
  # Extract cost from session-history.txt for this session
  local COST
  COST=$(grep "s=${SESSION} " "$HISTORY_FILE" 2>/dev/null | grep -oP 'cost=\$\K[0-9.]+' | tail -1 || echo "")

  if [[ -z "$COST" ]]; then
    echo "e-cost-cap: skip — no cost data yet for s${SESSION}"
    return 0
  fi

  # Compare cost to threshold (use node for float comparison)
  local OVER
  OVER=$(node -e "console.log(parseFloat('$COST') > parseFloat('$E_COST_THRESHOLD') ? 'yes' : 'no')" 2>/dev/null || echo "no")

  if [[ "$OVER" == "yes" ]]; then
    echo "e-cost-cap: WARN — s${SESSION} cost \$${COST} exceeds \$${E_COST_THRESHOLD} threshold"
    echo "WARN: E session s${SESSION} cost \$${COST} > \$${E_COST_THRESHOLD} cap" >> "$HOME/.config/moltbook/maintain-audit.txt" 2>/dev/null
  else
    echo "e-cost-cap: OK — s${SESSION} cost \$${COST} (threshold: \$${E_COST_THRESHOLD})"
  fi

  # Check registration count in trace
  if [[ "$HAS_TRACE" == "true" && -f "$TRACE_FILE" ]]; then
    local REG_COUNT
    REG_COUNT=$(node -e "
      const fs = require('fs');
      const traces = JSON.parse(fs.readFileSync('$TRACE_FILE', 'utf8'));
      const arr = Array.isArray(traces) ? traces : [traces];
      const t = arr.find(t => t.session === $SESSION);
      if (!t) { console.log(0); process.exit(0); }
      const text = JSON.stringify(t).toLowerCase();
      const keywords = ['register', 'signup', 'sign up', 'create account', 'new account', 'registration'];
      let count = 0;
      for (const kw of keywords) {
        const re = new RegExp(kw, 'gi');
        const matches = text.match(re);
        if (matches) count += matches.length;
      }
      // Normalize: count unique platform registrations, not keyword hits
      const platforms = t.platforms_engaged || [];
      const regPlatforms = platforms.filter(p => {
        const pText = JSON.stringify(t).toLowerCase();
        return keywords.some(kw => pText.includes(kw) && pText.includes(p.toLowerCase()));
      });
      console.log(Math.min(count > 0 ? Math.max(1, regPlatforms.length) : 0, 5));
    " 2>/dev/null || echo "0")

    if [[ "$REG_COUNT" -gt 1 ]]; then
      echo "e-cost-cap: WARN — s${SESSION} appears to have ${REG_COUNT} platform registrations (limit: 1)"
      echo "WARN: E session s${SESSION} had ${REG_COUNT} platform registrations (limit: 1)" >> "$HOME/.config/moltbook/maintain-audit.txt" 2>/dev/null
    elif [[ "$REG_COUNT" -eq 1 ]]; then
      echo "e-cost-cap: OK — 1 platform registration detected (within limit)"
    fi
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
