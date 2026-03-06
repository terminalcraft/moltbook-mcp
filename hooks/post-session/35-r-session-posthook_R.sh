#!/bin/bash
# 35-r-session-posthook_R.sh — Consolidated R-session post-hook dispatcher
#
# Merges 3 individual R-session post-hooks into a single dispatcher.
# Runs sequentially: commit gate first (produces commits that impact-track reads),
# then impact tracking, then brainstorm compliance.
#
# Replaces:
#   15-r-commit-gate.sh          (wq-528, wq-538)
#   18-r-impact-track.sh         (R#263)
#   26-brainstorm-compliance_R.sh (wq-365)
#
# Created: R#331 (d074 Group 3)

set -euo pipefail

[ "${MODE_CHAR:-}" = "R" ] || exit 0

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="$STATE_DIR/logs"
: "${SESSION_NUM:?SESSION_NUM required}"

mkdir -p "$LOG_DIR"
cd "$DIR"

###############################################################################
# Check 1: R commit gate (was 15-r-commit-gate.sh)
#   Auto-commit uncommitted R session changes with R#NNN markers.
#   Patches session-history.txt if note is empty or missing R#NNN.
###############################################################################
check_commit_gate() {
  local R_COUNTER_FILE="$STATE_DIR/r_session_counter"
  local HISTORY_FILE="$STATE_DIR/session-history.txt"
  local LOG_FILE_OUT="$LOG_DIR/r-commit-gate.log"

  # Read R session counter
  local R_NUM="unknown"
  if [ -f "$R_COUNTER_FILE" ]; then
    R_NUM=$(cat "$R_COUNTER_FILE" 2>/dev/null || echo "unknown")
  fi

  # Check for uncommitted changes (staged or unstaged, tracked files only)
  local HAS_CHANGES=0
  if ! git diff --quiet HEAD 2>/dev/null; then
    HAS_CHANGES=1
  fi
  if [ -n "$(git diff --cached --name-only 2>/dev/null)" ]; then
    HAS_CHANGES=1
  fi

  local CHANGED_FILES=""
  local DID_COMMIT=0

  if [ "$HAS_CHANGES" -eq 1 ]; then
    CHANGED_FILES=$(git diff --name-only HEAD 2>/dev/null | head -5 | tr '\n' ', ' | sed 's/,$//')
    if [ -z "$CHANGED_FILES" ]; then
      CHANGED_FILES=$(git diff --cached --name-only 2>/dev/null | head -5 | tr '\n' ', ' | sed 's/,$//')
    fi

    local COMMIT_MSG="refactor: R session changes (R#${R_NUM})

Files: ${CHANGED_FILES}
Auto-committed by r-commit-gate hook to ensure R#NNN tracking."

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
  if [ -f "$HISTORY_FILE" ]; then
    local ENTRY
    ENTRY=$(grep "s=$SESSION_NUM " "$HISTORY_FILE" | tail -1)
    if [ -n "$ENTRY" ]; then
      local CURRENT_NOTE
      CURRENT_NOTE=$(echo "$ENTRY" | sed -n 's/.*note: //p')

      local NEEDS_PATCH=0
      if [ -z "$CURRENT_NOTE" ]; then
        NEEDS_PATCH=1
      elif ! echo "$CURRENT_NOTE" | grep -qE 'R#[0-9]+'; then
        NEEDS_PATCH=1
      fi

      if [ "$NEEDS_PATCH" -eq 1 ]; then
        local NEW_NOTE
        if [ "$DID_COMMIT" -eq 1 ] && [ -n "$CHANGED_FILES" ]; then
          NEW_NOTE="refactor: R#${R_NUM} session changes ($CHANGED_FILES)"
        elif [ -n "$CURRENT_NOTE" ]; then
          NEW_NOTE="R#${R_NUM} (zero-output): ${CURRENT_NOTE}"
        else
          NEW_NOTE="R#${R_NUM} (zero-output): no commits, no file changes"
        fi

        local TEMP_FILE
        TEMP_FILE=$(mktemp)
        awk -v snum="s=$SESSION_NUM " -v note="$NEW_NOTE" '{
          if ($0 ~ snum) {
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
}

###############################################################################
# Check 2: R impact tracking (was 18-r-impact-track.sh)
#   Detect structural file changes from git, classify, delegate to Node.js
###############################################################################
check_impact_track() {
  local CHANGE_FILE
  CHANGE_FILE=$(git diff --name-only HEAD~2 HEAD 2>/dev/null \
    | grep -E '\.(sh|js|mjs|md|conf)$' | head -1 || echo "")

  local LATEST_COMMIT_MSG
  LATEST_COMMIT_MSG=$(git log -1 --format="%s" 2>/dev/null || echo "")

  # Filter pipeline repair operations (operational, not structural)
  if [[ "$LATEST_COMMIT_MSG" =~ ^chore:.*pipeline.*repair ]] || \
     [[ "$LATEST_COMMIT_MSG" =~ ^chore:.*replenish ]]; then
    echo "$(date -Iseconds) r-impact-track: skipping pipeline repair edit to $CHANGE_FILE"
    return
  fi

  # Classify category from filename
  local CHANGE_CATEGORY=""
  if [ -n "$CHANGE_FILE" ]; then
    case "$CHANGE_FILE" in
      SESSION_*.md) CHANGE_CATEGORY="session-file" ;;
      heartbeat.sh|rotation.conf|rotation-state.mjs) CHANGE_CATEGORY="orchestration" ;;
      hooks/*) CHANGE_CATEGORY="hooks" ;;
      index.js|api.mjs) CHANGE_CATEGORY="mcp-server" ;;
      components/*|providers/*) CHANGE_CATEGORY="components" ;;
      *.test.mjs|*.test.js) CHANGE_CATEGORY="tests" ;;
      BRAINSTORMING.md|work-queue.json|directives.json) CHANGE_CATEGORY="state-files" ;;
      *) CHANGE_CATEGORY="other" ;;
    esac
  fi

  # Detect intent from commit message
  local CHANGE_INTENT=""
  if [[ "$LATEST_COMMIT_MSG" =~ enforce.*budget ]] || \
     [[ "$LATEST_COMMIT_MSG" =~ budget.*minimum ]] || \
     [[ "$LATEST_COMMIT_MSG" =~ increase.*spending ]]; then
    CHANGE_INTENT="cost_increase"
  elif [[ "$LATEST_COMMIT_MSG" =~ reduce.*cost ]] || \
       [[ "$LATEST_COMMIT_MSG" =~ lower.*budget ]] || \
       [[ "$LATEST_COMMIT_MSG" =~ optimize.*spending ]]; then
    CHANGE_INTENT="cost_decrease"
  fi

  node "$DIR/lib/r-impact-tracker.mjs" \
    "${SESSION_NUM:-0}" "$CHANGE_FILE" "$CHANGE_CATEGORY" "$CHANGE_INTENT"

  echo "$(date -Iseconds) r-impact-track: s=${SESSION_NUM:-?} category=${CHANGE_CATEGORY:-none}"
}

###############################################################################
# Check 3: Brainstorm compliance (was 26-brainstorm-compliance_R.sh)
#   Verify R session replenished brainstorming (≥3 active ideas)
###############################################################################
check_brainstorm_compliance() {
  local BRAINSTORM="$DIR/BRAINSTORMING.md"
  local COMPLIANCE_LOG="$LOG_DIR/brainstorm-compliance.log"
  local MIN_IDEAS=3

  if [ ! -f "$BRAINSTORM" ]; then
    echo "$(date -Iseconds) s=${SESSION_NUM:-?} SKIP: BRAINSTORMING.md not found" >> "$COMPLIANCE_LOG"
    return
  fi

  local ACTIVE_COUNT
  ACTIVE_COUNT=$(grep -cE '^- \*\*' "$BRAINSTORM" 2>/dev/null || echo 0)

  if [ "$ACTIVE_COUNT" -lt "$MIN_IDEAS" ]; then
    echo "$(date -Iseconds) s=${SESSION_NUM:-?} FAIL: R session ended with $ACTIVE_COUNT active ideas (minimum: $MIN_IDEAS)" >> "$COMPLIANCE_LOG"
    echo "brainstorm-compliance: FAIL — $ACTIVE_COUNT/$MIN_IDEAS active ideas after R session"
  else
    echo "$(date -Iseconds) s=${SESSION_NUM:-?} PASS: $ACTIVE_COUNT active ideas" >> "$COMPLIANCE_LOG"
    echo "brainstorm-compliance: PASS — $ACTIVE_COUNT active ideas"
  fi
}

###############################################################################
# Run all checks sequentially
###############################################################################

check_commit_gate
check_impact_track
check_brainstorm_compliance

exit 0
