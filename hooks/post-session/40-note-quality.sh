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

# Check 1: Duration should not be "?"
if echo "$ENTRY" | grep -q 'dur=?'; then
  ISSUES="${ISSUES}dur=? (missing duration); "
fi

# Check 2: Extract note content
NOTE=$(echo "$ENTRY" | sed -n 's/.*note: //p')
if [ -z "$NOTE" ]; then
  ISSUES="${ISSUES}empty note; "
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
  if ! echo "$NOTE" | grep -qiE 'Session R#|structural|R#[0-9]+|reflect'; then
    ISSUES="${ISSUES}R session note missing session marker; "
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

# Report
if [ -n "$ISSUES" ]; then
  # Trim trailing "; "
  ISSUES="${ISSUES%; }"
  echo "$(date -Iseconds) s=$SESSION_NUM mode=$MODE_CHAR QUALITY: $ISSUES" >> "$LOG_FILE"
  echo "note-quality: s$SESSION_NUM issues: $ISSUES" >&2
else
  echo "$(date -Iseconds) s=$SESSION_NUM mode=$MODE_CHAR OK" >> "$LOG_FILE"
fi

exit 0
