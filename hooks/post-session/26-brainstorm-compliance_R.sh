#!/bin/bash
# Post-session: verify R session replenished brainstorming (wq-365).
# Checks that BRAINSTORMING.md has >= 3 active ideas after R session completes.
# If not, logs a compliance failure that A sessions can detect.
# Only runs on R sessions (enforced by _R.sh filename suffix).

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BRAINSTORM="$DIR/BRAINSTORMING.md"
COMPLIANCE_LOG="$HOME/.config/moltbook/logs/brainstorm-compliance.log"
MIN_IDEAS=3

mkdir -p "$(dirname "$COMPLIANCE_LOG")"

if [ ! -f "$BRAINSTORM" ]; then
  echo "$(date -Iseconds) s=${SESSION_NUM:-?} SKIP: BRAINSTORMING.md not found" >> "$COMPLIANCE_LOG"
  exit 0
fi

ACTIVE_COUNT=$(grep -cE '^- \*\*' "$BRAINSTORM" 2>/dev/null || echo 0)

if [ "$ACTIVE_COUNT" -lt "$MIN_IDEAS" ]; then
  echo "$(date -Iseconds) s=${SESSION_NUM:-?} FAIL: R session ended with $ACTIVE_COUNT active ideas (minimum: $MIN_IDEAS)" >> "$COMPLIANCE_LOG"
  echo "brainstorm-compliance: FAIL — $ACTIVE_COUNT/$MIN_IDEAS active ideas after R session"
else
  echo "$(date -Iseconds) s=${SESSION_NUM:-?} PASS: $ACTIVE_COUNT active ideas" >> "$COMPLIANCE_LOG"
  echo "brainstorm-compliance: PASS — $ACTIVE_COUNT active ideas"
fi
