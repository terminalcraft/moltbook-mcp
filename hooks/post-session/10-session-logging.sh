#!/bin/bash
# 10-session-logging.sh — Consolidated post-session logging dispatcher (d074 Group 8)
#
# Absorbs: 10-summarize.sh, 13-ctxly-summary.sh, 19-session-debrief.sh, 22-session-snapshots.sh
# NOT absorbed: 16-structured-outcomes.sh (depends on 15-cost-pipeline.sh ordering)
#
# Expects env: SESSION_NUM, MODE_CHAR, LOG_FILE, R_FOCUS, B_FOCUS
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="$STATE_DIR/logs"
mkdir -p "$LOG_DIR"

# =====================================================================
# Check 1: Session summary generation + history append
#   (from 10-summarize.sh)
# =====================================================================

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
  S_COMMITS=$(awk '
    /^Build:/ { in_build = 1; next }
    /^Feed:/ { in_feed = 1; if (in_build) in_build = 0; next }
    /^[A-Z]/ { in_build = 0; in_feed = 0 }
    in_build && /^ *- / { gsub(/^ *- /, ""); print; exit }
  ' "$SUMMARY_FILE" || true)
  if [ -z "$S_COMMITS" ]; then
    S_COMMITS=$(awk '
      /^--- Agent thinking ---/ { in_thinking = 1; next }
      in_thinking && /^\*\*[A-Z]? ?Session [0-9#]+.*Complete\*\*/ {
        gsub(/^\*\*/, ""); gsub(/\*\*/, "")
        print; exit
      }
      in_thinking && /^Session [A-Z]?#?[0-9]+.* [Cc]omplete[.!]/ {
        print; exit
      }
      in_thinking && /^##+ Session [A-Z]?#?[0-9]+.*[Ss]ummary/ {
        gsub(/^##+ /, "")
        print; exit
      }
      in_thinking && /^[0-9]+ substantive interactions completed\.$/ {
        print; exit
      }
      in_thinking && /^Pinchwork status:/ {
        print; exit
      }
    ' "$SUMMARY_FILE" || true)
  fi
  if [ -z "$S_COMMITS" ]; then
    S_COMMITS=$(awk '
      /^Feed:/ { in_feed = 1; next }
      /^[A-Z]/ { in_feed = 0 }
      in_feed && /^ *- / { gsub(/^ *- /, ""); print; exit }
    ' "$SUMMARY_FILE" || true)
  fi
  S_COST=$(grep '^Cost:' "$SUMMARY_FILE" | head -1 | awk '{print $2}' || true)
  S_FAILED=""
  if grep -q '^Failed:' "$SUMMARY_FILE"; then
    S_FAILED=$(awk '
      /^Failed:/ { in_failed = 1; next }
      /^[A-Z]/ { in_failed = 0 }
      in_failed && /^ *- / {
        gsub(/^ *- /, "")
        gsub(/ /, "_")
        if (length($0) > 50) $0 = substr($0, 1, 50)
        if (result) result = result "," $0
        else result = $0
      }
      END { if (result) print result }
    ' "$SUMMARY_FILE" || true)
  fi
  FULL_ENTRY="$(date +%Y-%m-%d) mode=$MODE_CHAR s=$S_NUM dur=$S_DUR ${S_COST:+cost=$S_COST }build=$S_BUILD ${S_FAILED:+failed=[$S_FAILED] }files=[$S_FILES] ${S_COMMITS:+note: $S_COMMITS}"
  if [ -f "$HISTORY_FILE" ] && grep -q "s=$S_NUM " "$HISTORY_FILE"; then
    if grep "s=$S_NUM " "$HISTORY_FILE" | grep -q "build=(started)"; then
      sed -i "/s=$S_NUM .*build=(started)/c\\$FULL_ENTRY" "$HISTORY_FILE"
    else
      echo "$(date -Iseconds) s=$S_NUM already in history, skipping" >> "$LOG_DIR/summarize-errors.log"
    fi
  else
    echo "$FULL_ENTRY" >> "$HISTORY_FILE"
  fi
  if [ "$(wc -l < "$HISTORY_FILE")" -gt 30 ]; then
    tail -30 "$HISTORY_FILE" > "$HISTORY_FILE.tmp" && mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"
  fi
fi

# =====================================================================
# Check 2: Ctxly cloud memory storage
#   (from 13-ctxly-summary.sh — depends on .summary from Check 1)
# =====================================================================

if [ -f "$SUMMARY_FILE" ]; then
  CTXLY_KEY=$(jq -r '.api_key // empty' "$DIR/ctxly.json" 2>/dev/null || true)
  if [ -n "$CTXLY_KEY" ]; then
    COMMITS=$(grep '^ *- ' "$SUMMARY_FILE" 2>/dev/null | head -3 | sed 's/^ *- //' | tr '\n' ';' | sed 's/;$//' || true)
    FILES_LINE=$(grep '^Files changed:' "$SUMMARY_FILE" 2>/dev/null | head -1 || true)
    FILES="${FILES_LINE#*: }"
    [ -z "$FILES" ] && FILES="none"

    MEMORY="Session ${SESSION_NUM:-?} (${MODE_CHAR:-?}): ${COMMITS:-no commits}. Files: $FILES."
    MEMORY="${MEMORY:0:500}"

    PAYLOAD=$(jq -nc --arg content "$MEMORY" '{content: $content, tags: ["session", "auto"]}')

    HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
      -X POST "https://ctxly.app/remember" \
      -H "Authorization: Bearer $CTXLY_KEY" \
      -H "Content-Type: application/json" \
      -H "User-Agent: moltbook-agent/1.0" \
      --max-time 10 \
      -d "$PAYLOAD" 2>/dev/null || echo "err")

    echo "$(date -Iseconds) s=${SESSION_NUM:-?} ctxly_remember: HTTP $HTTP_CODE" >> "$LOG_DIR/ctxly-sync.log"
  fi
fi

# =====================================================================
# Check 3: Session debrief extraction
#   (from 19-session-debrief.sh)
# =====================================================================

if [ -n "${LOG_FILE:-}" ] && [ -f "$LOG_FILE" ]; then
  FOCUS=""
  [ -n "${B_FOCUS:-}" ] && FOCUS="$B_FOCUS"
  [ -n "${R_FOCUS:-}" ] && FOCUS="$R_FOCUS"

  node "$DIR/scripts/session-debrief.mjs" "$LOG_FILE" "${SESSION_NUM:-0}" "${MODE_CHAR:-?}" "$FOCUS" 2>> "$LOG_DIR/debrief-errors.log" || true
fi

# =====================================================================
# Check 4: Ecosystem + pattern snapshots
#   (from 22-session-snapshots.sh)
# =====================================================================

PATTERNS=$(curl -s --max-time 5 http://localhost:3847/status/patterns 2>/dev/null) || true
PATTERNS_JSON="$PATTERNS" node "$DIR/hooks/lib/session-snapshots.mjs" "$DIR" "${SESSION_NUM:-0}" || true
