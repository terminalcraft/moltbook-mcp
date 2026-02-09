#!/bin/bash
# 15-r-commit-gate.sh — Ensure R sessions commit changes with R#NNN markers
#
# Problem: R sessions that edit files without committing produce empty session
# notes and miss R#NNN markers, degrading note quality metrics.
#
# Solution: After summarize (10) but before auto-commit (20), detect uncommitted
# changes in R sessions and commit them with proper R#NNN format.
#
# Also patches session-history.txt if the note is empty or missing R#NNN,
# INCLUDING zero-output sessions that produced no commits and no file changes.
# (wq-538: s1408 bypassed the gate by producing zero output)
#
# Only runs for R sessions. Non-fatal: always exits 0.
#
# Created: B#396 s1395 (wq-528)
# Extended: B#402 s1410 (wq-538) — zero-output session note patching
set -euo pipefail

[ "${MODE_CHAR:-}" = "R" ] || exit 0

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
R_COUNTER_FILE="$STATE_DIR/r_session_counter"
HISTORY_FILE="$STATE_DIR/session-history.txt"
LOG_DIR="$STATE_DIR/logs"
LOG_FILE_OUT="$LOG_DIR/r-commit-gate.log"

: "${SESSION_NUM:?SESSION_NUM required}"

mkdir -p "$LOG_DIR"
cd "$DIR"

# Read R session counter
R_NUM="unknown"
if [ -f "$R_COUNTER_FILE" ]; then
  R_NUM=$(cat "$R_COUNTER_FILE" 2>/dev/null || echo "unknown")
fi

# Check for uncommitted changes (staged or unstaged, tracked files only)
HAS_CHANGES=0
if ! git diff --quiet HEAD 2>/dev/null; then
  HAS_CHANGES=1
fi
if [ -n "$(git diff --cached --name-only 2>/dev/null)" ]; then
  HAS_CHANGES=1
fi

CHANGED_FILES=""
DID_COMMIT=0

if [ "$HAS_CHANGES" -eq 1 ]; then
  # Build commit message from changed files
  CHANGED_FILES=$(git diff --name-only HEAD 2>/dev/null | head -5 | tr '\n' ', ' | sed 's/,$//')
  if [ -z "$CHANGED_FILES" ]; then
    CHANGED_FILES=$(git diff --cached --name-only 2>/dev/null | head -5 | tr '\n' ', ' | sed 's/,$//')
  fi

  COMMIT_MSG="refactor: R session changes (R#${R_NUM})

Files: ${CHANGED_FILES}
Auto-committed by r-commit-gate hook to ensure R#NNN tracking."

  # Stage and commit
  git add -- '*.md' '*.js' '*.cjs' '*.mjs' '*.json' '*.sh' '*.py' '*.txt' \
    '.gitignore' 'LICENSE' 2>/dev/null || true
  git add -u 2>/dev/null || true

  if ! git diff --cached --quiet 2>/dev/null; then
    git commit -m "$COMMIT_MSG" --no-gpg-sign 2>/dev/null || {
      echo "$(date -Iseconds) s=$SESSION_NUM R#$R_NUM: commit failed" >> "$LOG_FILE_OUT"
    }
    DID_COMMIT=1
    echo "$(date -Iseconds) s=$SESSION_NUM R#$R_NUM: auto-committed R session changes ($CHANGED_FILES)" >> "$LOG_FILE_OUT"
  else
    echo "$(date -Iseconds) s=$SESSION_NUM R#$R_NUM: nothing staged after add" >> "$LOG_FILE_OUT"
  fi
else
  echo "$(date -Iseconds) s=$SESSION_NUM R#$R_NUM: no uncommitted changes" >> "$LOG_FILE_OUT"
fi

# --- Note patching: runs for ALL R sessions, regardless of commit status ---
# This catches zero-output sessions (no commits, no file changes) that still
# need R#NNN markers in their session history notes. (wq-538)
if [ -f "$HISTORY_FILE" ]; then
  ENTRY=$(grep "s=$SESSION_NUM " "$HISTORY_FILE" | tail -1)
  if [ -n "$ENTRY" ]; then
    # Extract current note
    CURRENT_NOTE=$(echo "$ENTRY" | sed -n 's/.*note: //p')

    # Determine if note needs patching
    NEEDS_PATCH=0
    if [ -z "$CURRENT_NOTE" ]; then
      NEEDS_PATCH=1
    elif ! echo "$CURRENT_NOTE" | grep -qE 'R#[0-9]+'; then
      NEEDS_PATCH=1
    fi

    if [ "$NEEDS_PATCH" -eq 1 ]; then
      if [ "$DID_COMMIT" -eq 1 ] && [ -n "$CHANGED_FILES" ]; then
        NEW_NOTE="refactor: R#${R_NUM} session changes ($CHANGED_FILES)"
      elif [ -n "$CURRENT_NOTE" ]; then
        # Zero-output session with a note but no R# marker — prepend R#NNN
        NEW_NOTE="R#${R_NUM} (zero-output): ${CURRENT_NOTE}"
      else
        # Zero-output session with empty note
        NEW_NOTE="R#${R_NUM} (zero-output): no commits, no file changes"
      fi

      # Use awk for robust line replacement (avoids sed escaping issues)
      TEMP_FILE=$(mktemp)
      awk -v snum="s=$SESSION_NUM " -v note="$NEW_NOTE" '{
        if ($0 ~ snum) {
          # Check if line already has "note:" field
          if ($0 ~ /note: /) {
            sub(/note: .*/, "note: " note)
          } else {
            $0 = $0 " note: " note
          }
        }
        print
      }' "$HISTORY_FILE" > "$TEMP_FILE"
      mv "$TEMP_FILE" "$HISTORY_FILE"

      echo "$(date -Iseconds) s=$SESSION_NUM R#$R_NUM: patched history note (zero-output=$((1-DID_COMMIT)))" >> "$LOG_FILE_OUT"
    fi
  fi
fi

exit 0
