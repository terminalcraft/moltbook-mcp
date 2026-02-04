#!/bin/bash
# Verify A sessions create work-queue items (wq-171)
# A sessions must create audit-tagged items in work-queue.json.
# If no items with current session's created_session were added, log a violation.
#
# This prevents audits that diagnose issues but never create actionable work items.

set -euo pipefail

# Only run for A (Audit) sessions
[ "${MODE_CHAR:-}" = "A" ] || exit 0

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="$STATE_DIR/logs"
VIOLATION_LOG="$LOG_DIR/audit-violations.log"

SESSION=${SESSION_NUM:-0}

# Check work-queue.json for items created this session
if [ ! -f "$DIR/work-queue.json" ]; then
  echo "$(date -Iseconds) s=$SESSION VIOLATION: work-queue.json not found" >> "$VIOLATION_LOG"
  echo "AUDIT VIOLATION: work-queue.json not found"
  exit 0
fi

# Count audit-tagged items with created_session matching current session
ITEMS_CREATED=$(node -e "
  const q = JSON.parse(require('fs').readFileSync('$DIR/work-queue.json', 'utf8'));
  const items = q.queue || [];
  const created = items.filter(i =>
    i.created_session === $SESSION &&
    i.tags && i.tags.includes('audit')
  );
  console.log(created.length);
" 2>/dev/null || echo "0")

if [ "$ITEMS_CREATED" = "0" ]; then
  echo "$(date -Iseconds) s=$SESSION VIOLATION: A session created 0 audit-tagged work-queue items" >> "$VIOLATION_LOG"
  echo "AUDIT VIOLATION: No audit-tagged work-queue items created this session (s$SESSION)"
  echo "A sessions MUST create work-queue items for recommended actions. See SESSION_AUDIT.md Step 2."
else
  echo "$(date -Iseconds) s=$SESSION OK: $ITEMS_CREATED audit-tagged items created" >> "$VIOLATION_LOG"
  echo "Audit compliance: $ITEMS_CREATED work-queue items created"
fi
