#!/bin/bash
# 40-note-quality.sh — Validate session-history.txt entry quality
#
# Checks the just-written session-history.txt entry for:
# 1. Proper duration (not dur=?)
# 2. Non-empty, substantive notes (not truncated garbage)
# 3. Mode-specific completion markers (E sessions should have "Session E#NNN complete")
# 4. Reasonable field presence (mode, session num, build info)
#
# Writes warnings to stderr and logs issues to ~/.config/moltbook/logs/note-quality.log
# Non-fatal: always exits 0
#
# Created: B#390 s1372 (wq-507)
set -euo pipefail

STATE_DIR="$HOME/.config/moltbook"
HISTORY_FILE="$STATE_DIR/session-history.txt"
LOG_DIR="$STATE_DIR/logs"
LOG_FILE="$LOG_DIR/note-quality.log"

: "${SESSION_NUM:?SESSION_NUM required}"
: "${MODE_CHAR:?MODE_CHAR required}"

[ -f "$HISTORY_FILE" ] || exit 0
mkdir -p "$LOG_DIR"

# Find the history line for this session
ENTRY=$(grep "s=$SESSION_NUM " "$HISTORY_FILE" | tail -1)
[ -n "$ENTRY" ] || {
  echo "$(date -Iseconds) s=$SESSION_NUM WARN: no history entry found" >> "$LOG_FILE"
  exit 0
}

ISSUES=""
SEVERITY="normal"

# Check 1: Duration should not be "?"
if echo "$ENTRY" | grep -q 'dur=?'; then
  ISSUES="${ISSUES}dur=? (missing duration); "
fi

# Check 2: Extract note content
NOTE=$(echo "$ENTRY" | sed -n 's/.*note: //p')
if [ -z "$NOTE" ]; then
  ISSUES="${ISSUES}empty note; "
  # Empty R notes are critical — R sessions must always produce summaries
  if [ "$MODE_CHAR" = "R" ]; then
    SEVERITY="critical"
  fi
elif [ "${#NOTE}" -lt 15 ]; then
  ISSUES="${ISSUES}short note (${#NOTE} chars); "
fi

# Check 3: Detect garbage notes (common truncation patterns)
if [ -n "$NOTE" ]; then
  # These patterns indicate the session was truncated before producing a real summary
  if echo "$NOTE" | grep -qiE '^(Let me|I.ll |Now |Here.s my|Starting|First,? let)'; then
    ISSUES="${ISSUES}truncated note (starts with agent preamble); "
  fi
fi

# Check 4: E session completion marker
if [ "$MODE_CHAR" = "E" ] && [ -n "$NOTE" ]; then
  if ! echo "$NOTE" | grep -qiE 'Session E#[0-9]+.*complete|engaged|engagement'; then
    ISSUES="${ISSUES}E session note missing completion/engagement marker; "
  fi
fi

# Check 5: R session completion marker
if [ "$MODE_CHAR" = "R" ] && [ -n "$NOTE" ]; then
  # R sessions MUST include R#NNN marker — "reflect"/"structural" alone insufficient
  if ! echo "$NOTE" | grep -qE 'R#[0-9]+'; then
    ISSUES="${ISSUES}R session note missing R#NNN marker; "
    SEVERITY="high"
  fi
  # R notes that are just git commit messages (e.g. "refactor: foo (R#229)") lack session context
  if echo "$NOTE" | grep -qE '^(feat|fix|refactor|chore|docs|test|ci|style|perf)\(?.*:' && [ "${#NOTE}" -lt 100 ]; then
    ISSUES="${ISSUES}R session note is commit-message-only (missing session summary); "
  fi
  # R notes that are raw diagnostic/analysis content without summary structure
  if ! echo "$NOTE" | grep -qiE 'R#[0-9]+|complete|session summary'; then
    if [ "${#NOTE}" -gt 50 ] && echo "$NOTE" | grep -qiE '^The |^This |^I found|^Looking|^After|^Session history'; then
      ISSUES="${ISSUES}R session note is diagnostic content without session summary; "
    fi
  fi
fi

# Check 6: A session completion marker
if [ "$MODE_CHAR" = "A" ] && [ -n "$NOTE" ]; then
  if ! echo "$NOTE" | grep -qiE 'Session A#|audit|A#[0-9]+'; then
    ISSUES="${ISSUES}A session note missing audit marker; "
  fi
fi

# Check 7: build=(started) should have been replaced by summarize hook
if echo "$ENTRY" | grep -q 'build=(started)'; then
  ISSUES="${ISSUES}build=(started) placeholder not replaced; "
fi

# Check 8: "session started, awaiting completion" is a default placeholder note
if [ -n "$NOTE" ] && echo "$NOTE" | grep -qi 'session started, awaiting completion'; then
  ISSUES="${ISSUES}placeholder note (session started, awaiting completion); "
fi

# Report
if [ -n "$ISSUES" ]; then
  # Trim trailing "; "
  ISSUES="${ISSUES%; }"
  echo "$(date -Iseconds) s=$SESSION_NUM mode=$MODE_CHAR severity=$SEVERITY QUALITY: $ISSUES" >> "$LOG_FILE"
  echo "note-quality: s$SESSION_NUM [$SEVERITY] issues: $ISSUES" >&2
else
  echo "$(date -Iseconds) s=$SESSION_NUM mode=$MODE_CHAR OK" >> "$LOG_FILE"
fi

# R session rolling quality metric (last 10 R sessions)
# Writes pass/fail ratio to a file audits can consume directly
if [ "$MODE_CHAR" = "R" ]; then
  R_QUALITY_FILE="$LOG_DIR/r-session-quality.txt"
  # Count recent R session quality from log
  R_TOTAL=$(grep -c "mode=R " "$LOG_FILE" 2>/dev/null || echo 0)
  R_PASS=$(grep "mode=R OK" "$LOG_FILE" | tail -10 | wc -l)
  R_RECENT=$(grep "mode=R " "$LOG_FILE" | tail -10 | wc -l)
  if [ "$R_RECENT" -gt 0 ]; then
    R_PCT=$((R_PASS * 100 / R_RECENT))
    echo "r_quality_pct=$R_PCT r_pass=$R_PASS r_recent=$R_RECENT updated=$(date -Iseconds)" > "$R_QUALITY_FILE"
  fi
fi

exit 0
