#!/bin/bash
# Pre-session brainstorming health gate for R sessions (wq-365).
# Counts active (non-struck-through) ideas in BRAINSTORMING.md.
# Writes WARNING to maintain-audit.txt when < 3 active ideas.
# R sessions read maintain-audit.txt in step 2 and must act on WARNs.
# Only runs on R sessions (enforced by _R.sh filename suffix).

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BRAINSTORM="$DIR/BRAINSTORMING.md"
AUDIT_FILE="$HOME/.config/moltbook/maintain-audit.txt"
MIN_IDEAS=3

if [ ! -f "$BRAINSTORM" ]; then
  echo "brainstorm-gate: BRAINSTORMING.md not found"
  exit 0
fi

# Count active ideas: lines starting with "- **" (not struck-through "- ~~")
# Exclude directive placeholders ("Address directive", "Fix credential", etc.)
# which are tracked in directives.json and don't represent fresh build ideas.
# Only count ideas with "(added ~sNNN)" session markers as genuinely fresh.
TOTAL_ACTIVE=$(grep -cE '^- \*\*' "$BRAINSTORM" 2>/dev/null || echo 0)
FRESH_COUNT=$(grep -cE '^- \*\*.+\(added ~s[0-9]+\)' "$BRAINSTORM" 2>/dev/null || echo 0)
ACTIVE_COUNT=$FRESH_COUNT

if [ "$ACTIVE_COUNT" -lt "$MIN_IDEAS" ]; then
  MSG="WARN: BRAINSTORMING.md has only $ACTIVE_COUNT active idea(s) (minimum: $MIN_IDEAS). You MUST add $(($MIN_IDEAS - $ACTIVE_COUNT))+ new ideas before closing this R session."
  echo "$MSG"
  # Append to audit file so it's visible in the session prompt
  if [ -f "$AUDIT_FILE" ]; then
    echo "" >> "$AUDIT_FILE"
    echo "=== Brainstorming health ===" >> "$AUDIT_FILE"
    echo "$MSG" >> "$AUDIT_FILE"
  fi
else
  echo "brainstorm-gate: $ACTIVE_COUNT fresh ideas ($TOTAL_ACTIVE total active) (healthy)"
fi
