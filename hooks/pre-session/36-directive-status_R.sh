#!/bin/bash
# Pre-session directive status for R sessions.
# Surfaces which directives need attention in step 5 (directive maintenance).
# Reduces manual scanning by pre-computing maintenance needs.
# Added R#185: closes the directive-update compliance gap.
# Updated R#189: staleness now considers notes field for recent activity,
#   not just acked_session. Fixes false positives for directives with recent
#   notes but old ack dates (d044, d045, d047 were showing as stale incorrectly).
# Updated R#197: system/monitoring directives use 60-session threshold instead
#   of 30. Directives with from="system" are ongoing monitors (e.g. d049 intel
#   minimum) that only need periodic "still healthy" notes, not active work.
#   This eliminates false staleness alerts that create busywork for R sessions.
# Updated R#278: scoped directives (with scope field like d067, d068) are
#   standing behavioral rules enforced by session-type behavior. They use a
#   50-session staleness threshold and don't trigger NEEDS_UPDATE for missing
#   queue items — only for missing review notes.
#
# Output: ~/.config/moltbook/directive-status.txt
# Categories: NEEDS_UPDATE, STALE, PENDING_QUESTION, HEALTHY

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATUS_FILE="$HOME/.config/moltbook/directive-status.txt"
DIRECTIVES_FILE="$DIR/directives.json"
QUEUE_FILE="$DIR/work-queue.json"

# Session number for staleness calculation
SESSION_NUM="${SESSION_NUM:-1100}"

echo "=== Directive status $(date -Iseconds) s=$SESSION_NUM ===" > "$STATUS_FILE"

if [ ! -f "$DIRECTIVES_FILE" ]; then
  echo "ERROR: directives.json not found" >> "$STATUS_FILE"
  echo "Directive status: directives.json missing"
  exit 0
fi

# Pre-compute directive maintenance needs using jq
# Categories:
#   NEEDS_UPDATE: active directive with no recent notes (>20 sessions since last activity)
#   STALE: active directive with no activity >30 sessions
#   PENDING_QUESTION: has pending question awaiting human response
#   NO_QUEUE_ITEM: active directive without corresponding queue item
#
# "Last activity" = max of:
#   - acked_session
#   - session numbers found in notes (patterns: R#NNN, s=NNN, sNNN)

# Extract queue item titles for cross-reference
QUEUE_TITLES=""
if [ -f "$QUEUE_FILE" ]; then
  QUEUE_TITLES=$(jq -r '.queue[] | select(.status == "pending" or .status == "in-progress") | .title // .description' "$QUEUE_FILE" 2>/dev/null | tr '\n' '|')
fi

# Helper: extract max session number from notes field
# Patterns: R#189, s=1119, s1119, (s1119)
extract_max_session_from_notes() {
  local notes="$1"
  local max_session=0

  # Extract all session references
  # R#NNN -> NNN * 5 (rough approximation: ~5 sessions per R session)
  # Actually, just extract sNNN patterns directly for accuracy
  while read -r num; do
    if [ -n "$num" ] && [ "$num" -gt "$max_session" ] 2>/dev/null; then
      max_session=$num
    fi
  done < <(echo "$notes" | grep -oE 's[0-9]+|s=[0-9]+' | grep -oE '[0-9]+' || true)

  echo "$max_session"
}

# Analyze directives
NEEDS_ATTENTION=0
HEALTHY=0

# Check active directives - now include notes field
# Use tab as delimiter since notes often contain | characters
while IFS=$'\t' read -r ID STATUS ACKED NOTES CONTENT FROM SCOPE; do
  [ -z "$ID" ] && continue
  [ "$STATUS" != "active" ] && continue

  # Threshold tiers by directive type:
  # - system: ongoing monitors (d049), need periodic "still healthy" notes
  # - scoped: standing behavioral rules with scope field (d067, d068),
  #   don't need queue items — they're enforced by session-type behavior
  # - default: task-oriented directives that should have queue items
  HAS_SCOPE="no"
  if [ -n "$SCOPE" ] && [ "$SCOPE" != "null" ]; then
    HAS_SCOPE="yes"
  fi

  if [ "$FROM" = "system" ]; then
    STALE_THRESHOLD=60
    NEEDS_UPDATE_THRESHOLD=40
  elif [ "$HAS_SCOPE" = "yes" ]; then
    STALE_THRESHOLD=50
    NEEDS_UPDATE_THRESHOLD=35
  else
    STALE_THRESHOLD=30
    NEEDS_UPDATE_THRESHOLD=20
  fi

  # Calculate last activity session
  LAST_ACTIVITY=0

  # Start with acked_session
  if [ -n "$ACKED" ] && [ "$ACKED" != "null" ]; then
    LAST_ACTIVITY=$ACKED
  fi

  # Check notes for more recent session references
  if [ -n "$NOTES" ] && [ "$NOTES" != "null" ]; then
    NOTES_SESSION=$(extract_max_session_from_notes "$NOTES")
    if [ "$NOTES_SESSION" -gt "$LAST_ACTIVITY" ] 2>/dev/null; then
      LAST_ACTIVITY=$NOTES_SESSION
    fi
  fi

  # Calculate sessions since last activity
  if [ "$LAST_ACTIVITY" -gt 0 ]; then
    SESSIONS_SINCE=$((SESSION_NUM - LAST_ACTIVITY))
  else
    SESSIONS_SINCE=999
  fi

  # Check if directive has corresponding queue item
  HAS_QUEUE="no"
  if echo "$QUEUE_TITLES" | grep -qi "$ID" 2>/dev/null; then
    HAS_QUEUE="yes"
  fi

  # Truncate content for display
  CONTENT_SHORT=$(echo "$CONTENT" | head -c 60)

  # Determine status (thresholds are directive-type-dependent since R#197)
  if [ "$SESSIONS_SINCE" -gt "$STALE_THRESHOLD" ]; then
    echo "STALE: $ID (${SESSIONS_SINCE} sessions since s${LAST_ACTIVITY}, threshold=${STALE_THRESHOLD}) - $CONTENT_SHORT..." >> "$STATUS_FILE"
    NEEDS_ATTENTION=$((NEEDS_ATTENTION + 1))
  elif [ "$SESSIONS_SINCE" -gt "$NEEDS_UPDATE_THRESHOLD" ] && [ "$HAS_QUEUE" = "no" ] && [ "$HAS_SCOPE" = "no" ]; then
    echo "NEEDS_UPDATE: $ID (${SESSIONS_SINCE} sessions, no queue item, threshold=${NEEDS_UPDATE_THRESHOLD}) - $CONTENT_SHORT..." >> "$STATUS_FILE"
  elif [ "$SESSIONS_SINCE" -gt "$NEEDS_UPDATE_THRESHOLD" ] && [ "$HAS_SCOPE" = "yes" ]; then
    echo "NEEDS_UPDATE: $ID (${SESSIONS_SINCE} sessions, standing/scope=$SCOPE, threshold=${NEEDS_UPDATE_THRESHOLD}) - $CONTENT_SHORT..." >> "$STATUS_FILE"
    NEEDS_ATTENTION=$((NEEDS_ATTENTION + 1))
  else
    HEALTHY=$((HEALTHY + 1))
  fi
done < <(jq -r '.directives[] | select(.status == "active") | [.id, .status, (.acked_session // "null" | tostring), (.notes // ""), (.content // ""), (.from // "human"), (.scope // "null")] | @tsv' "$DIRECTIVES_FILE" 2>/dev/null)

# Check pending questions
PENDING_Q=$(jq -r '.questions[] | select(.status == "pending") | "\(.id): \(.question | .[0:50])..."' "$DIRECTIVES_FILE" 2>/dev/null || true)
if [ -n "$PENDING_Q" ]; then
  echo "" >> "$STATUS_FILE"
  echo "PENDING QUESTIONS (awaiting human):" >> "$STATUS_FILE"
  echo "$PENDING_Q" >> "$STATUS_FILE"
  NEEDS_ATTENTION=$((NEEDS_ATTENTION + 1))
fi

# Summary
echo "" >> "$STATUS_FILE"
if [ "$NEEDS_ATTENTION" -eq 0 ]; then
  echo "SUMMARY: All $HEALTHY active directives healthy. Add review note to most recent." >> "$STATUS_FILE"
  echo "Directive status: $HEALTHY healthy, step 5 = add review note"
else
  echo "SUMMARY: $NEEDS_ATTENTION directive(s) need attention, $HEALTHY healthy." >> "$STATUS_FILE"
  echo "Directive status: $NEEDS_ATTENTION need attention"
fi

# Append to maintain-audit.txt for visibility in session prompt
AUDIT_FILE="$HOME/.config/moltbook/maintain-audit.txt"
if [ -f "$AUDIT_FILE" ]; then
  echo "" >> "$AUDIT_FILE"
  cat "$STATUS_FILE" >> "$AUDIT_FILE"
fi
