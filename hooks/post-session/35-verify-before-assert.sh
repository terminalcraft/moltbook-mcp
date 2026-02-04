#!/bin/bash
# Post-session hook: Verify-before-assert discipline (wq-233)
# Compares claimed file changes (from summarize) against actual git diff.
# Logs mismatches for audit. Does not block session completion.
#
# From shinobi-187 identity pattern: "no claims of edits/actions without
# pointing to file path + diff or DB query result"

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="$STATE_DIR/logs"
VERIFY_LOG="$LOG_DIR/verify-before-assert.log"
SUMMARY_FILE="${LOG_FILE%.log}.summary"

: "${SESSION_NUM:?SESSION_NUM required}"

# Only meaningful for B and R sessions that make code changes
if [[ "${MODE_CHAR:-}" != "B" && "${MODE_CHAR:-}" != "R" ]]; then
    exit 0
fi

# Need summary file
if [[ ! -f "$SUMMARY_FILE" ]]; then
    exit 0
fi

# Parse claimed files from summary
CLAIMED_FILES=$(grep '^Files changed:' "$SUMMARY_FILE" | sed 's/^Files changed: //' | tr ',' '\n' | sed 's/^ *//' | sed 's/ *$//' | sort -u)

# Skip if no files claimed or claim is "(none)"
if [[ -z "$CLAIMED_FILES" || "$CLAIMED_FILES" == "(none)" ]]; then
    exit 0
fi

# Get actual changed files from recent git commits (last 5, within session window)
cd "$DIR"
ACTUAL_FILES=$(git diff --name-only HEAD~5 HEAD 2>/dev/null | xargs -I{} basename {} | sort -u || echo "")

# Compare: find claimed files not in actual
MISMATCHES=""
while IFS= read -r claimed; do
    [[ -z "$claimed" ]] && continue
    if ! echo "$ACTUAL_FILES" | grep -qx "$claimed"; then
        MISMATCHES="${MISMATCHES}claimed-not-in-diff:$claimed;"
    fi
done <<< "$CLAIMED_FILES"

# Log result
if [[ -n "$MISMATCHES" ]]; then
    echo "$(date -Iseconds) s=$SESSION_NUM MISMATCH: $MISMATCHES" >> "$VERIFY_LOG"
    echo "verify-before-assert: MISMATCH detected — check $VERIFY_LOG"
else
    echo "$(date -Iseconds) s=$SESSION_NUM OK: claimed=$CLAIMED_FILES" >> "$VERIFY_LOG"
fi
