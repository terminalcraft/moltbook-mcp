#!/bin/bash
# Pre-session directive status for R sessions.
# Surfaces which directives need attention in step 5 (directive maintenance).
# Reduces manual scanning by pre-computing maintenance needs.
# Added R#185: closes the directive-update compliance gap.
# R#317: Analysis logic extracted to hooks/lib/directive-analysis.mjs.
#   Shell is now a thin dispatcher (was 204 lines of inline parsing).
#
# Output: ~/.config/moltbook/directive-status.txt
# Categories: NEEDS_UPDATE, STALE, PENDING_QUESTION, HEALTHY

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATUS_FILE="$HOME/.config/moltbook/directive-status.txt"
DIRECTIVES_FILE="$DIR/directives.json"
QUEUE_FILE="$DIR/work-queue.json"
HISTORY_FILE="$HOME/.config/moltbook/session-history.txt"

SESSION_NUM="${SESSION_NUM:-1100}"

echo "=== Directive status $(date -Iseconds) s=$SESSION_NUM ===" > "$STATUS_FILE"

if [ ! -f "$DIRECTIVES_FILE" ]; then
  echo "ERROR: directives.json not found" >> "$STATUS_FILE"
  echo "Directive status: directives.json missing"
  exit 0
fi

# R#317: delegate all analysis to directive-analysis.mjs
OUTPUT=$(node "$DIR/hooks/lib/directive-analysis.mjs" \
  "$SESSION_NUM" "$DIRECTIVES_FILE" "$QUEUE_FILE" "$HISTORY_FILE" 2>/dev/null) || {
  echo "ERROR: directive-analysis.mjs failed" >> "$STATUS_FILE"
  echo "Directive status: analysis failed"
  exit 0
}

echo "$OUTPUT" >> "$STATUS_FILE"

# Extract summary line for console output
SUMMARY=$(echo "$OUTPUT" | grep "^SUMMARY:" | sed 's/^SUMMARY: //')
NEEDS_ATTENTION=$(echo "$OUTPUT" | grep -cE '^(STALE|NEEDS_UPDATE|PENDING)' || true)

if [ "$NEEDS_ATTENTION" -eq 0 ]; then
  echo "Directive status: healthy, step 5 = add review note"
else
  echo "Directive status: $NEEDS_ATTENTION need attention"
fi

# Append to maintain-audit.txt for visibility in session prompt
AUDIT_FILE="$HOME/.config/moltbook/maintain-audit.txt"
if [ -f "$AUDIT_FILE" ]; then
  echo "" >> "$AUDIT_FILE"
  cat "$STATUS_FILE" >> "$AUDIT_FILE"
fi
