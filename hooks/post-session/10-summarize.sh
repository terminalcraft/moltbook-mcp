#!/bin/bash
# Generate session summary and append to history
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="$STATE_DIR/logs"

SUMM_ERR=$(python3 "$DIR/scripts/summarize-session.py" "$LOG_FILE" "$SESSION_NUM" 2>&1) || {
  echo "$(date -Iseconds) s=${SESSION_NUM:-?} ERROR: summarize failed: ${SUMM_ERR:0:300}" >> "$LOG_DIR/summarize-errors.log"
}

SUMMARY_FILE="${LOG_FILE%.log}.summary"
HISTORY_FILE="$STATE_DIR/session-history.txt"
if [ -f "$SUMMARY_FILE" ]; then
  S_NUM=$(grep '^Session:' "$SUMMARY_FILE" | head -1 | awk '{print $2}' || true)
  S_DUR=$(grep '^Duration:' "$SUMMARY_FILE" | head -1 | awk '{print $2}' || true)
  S_BUILD=$(grep '^Build:' "$SUMMARY_FILE" | head -1 | cut -d' ' -f2- || true)
  S_FILES=$(grep '^Files changed:' "$SUMMARY_FILE" | head -1 | cut -d' ' -f3- || true)
  # Extract note: prefer commit message (after "Build:") over summary lines
  # For B sessions: use first commit message
  # For E sessions: look for completion/summary patterns in the agent thinking section
  S_COMMITS=$(awk '
    /^Build:/ { in_build = 1; next }
    /^Feed:/ { in_feed = 1; if (in_build) in_build = 0; next }
    /^[A-Z]/ { in_build = 0; in_feed = 0 }
    in_build && /^ *- / { gsub(/^ *- /, ""); print; exit }
  ' "$SUMMARY_FILE" || true)
  # If no commit found (E/A sessions), extract completion summary from thinking section
  # Priority: explicit "Complete" markers > "substantive interactions" > Pinchwork status
  if [ -z "$S_COMMITS" ]; then
    S_COMMITS=$(awk '
      /^--- Agent thinking ---/ { in_thinking = 1; next }
      # Priority 1: Bold session complete markers (e.g., **Session 838 (E#33) Complete**)
      in_thinking && /^\*\*[A-Z]? ?Session [0-9#]+.*Complete\*\*/ {
        gsub(/^\*\*/, ""); gsub(/\*\*/, "")
        print; exit
      }
      # Priority 2: Plain session complete (e.g., Session E#823 complete.)
      # Pattern requires Complete/complete at END with optional punctuation
      in_thinking && /^Session [A-Z]?#?[0-9]+.* [Cc]omplete[.!]?$/ {
        print; exit
      }
      # Priority 3: Heading session summary (e.g., ## Session E#28 Summary)
      in_thinking && /^##+ Session [A-Z]?#?[0-9]+.*[Ss]ummary/ {
        gsub(/^##+ /, "")
        print; exit
      }
      # Priority 4: "N substantive interactions completed." (fallback for older format)
      in_thinking && /^[0-9]+ substantive interactions completed\.$/ {
        print; exit
      }
      # Priority 5: Pinchwork status
      in_thinking && /^Pinchwork status:/ {
        print; exit
      }
    ' "$SUMMARY_FILE" || true)
  fi
  # Fallback: first Feed line if still empty
  if [ -z "$S_COMMITS" ]; then
    S_COMMITS=$(awk '
      /^Feed:/ { in_feed = 1; next }
      /^[A-Z]/ { in_feed = 0 }
      in_feed && /^ *- / { gsub(/^ *- /, ""); print; exit }
    ' "$SUMMARY_FILE" || true)
  fi
  S_COST=$(grep '^Cost:' "$SUMMARY_FILE" | head -1 | awk '{print $2}' || true)
  # Dedup: skip if this session number already exists in history
  if [ -f "$HISTORY_FILE" ] && grep -q "s=$S_NUM " "$HISTORY_FILE"; then
    echo "$(date -Iseconds) s=$S_NUM already in history, skipping" >> "$LOG_DIR/summarize-errors.log"
  else
    echo "$(date +%Y-%m-%d) mode=$MODE_CHAR s=$S_NUM dur=$S_DUR ${S_COST:+cost=$S_COST }build=$S_BUILD files=[$S_FILES] ${S_COMMITS:+note: $S_COMMITS}" >> "$HISTORY_FILE"
  fi
  if [ "$(wc -l < "$HISTORY_FILE")" -gt 30 ]; then
    tail -30 "$HISTORY_FILE" > "$HISTORY_FILE.tmp" && mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"
  fi
fi
