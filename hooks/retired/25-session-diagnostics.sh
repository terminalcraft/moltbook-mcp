#!/bin/bash
# Pre-session: run session diagnostics and log warnings
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DIAG_LOG="$HOME/.config/moltbook/logs/diagnostics.log"

log() { echo "$(date -Iseconds) s=${SESSION_NUM:-?} $*" >> "$DIAG_LOG"; }

# Check for session gaps
GAPS=$(python3 "$DIR/scripts/session-gaps.py" 2>/dev/null) || true
if echo "$GAPS" | grep -q "Missing sessions"; then
  log "WARN: $GAPS"
fi

# Check directive-audit log for recent errors
AUDIT_LOG="$HOME/.config/moltbook/logs/directive-audit.log"
if [ -f "$AUDIT_LOG" ]; then
  RECENT_ERRORS=$(tail -5 "$AUDIT_LOG" | grep -c "ERROR" || true)
  if [ "$RECENT_ERRORS" -gt 0 ]; then
    log "WARN: $RECENT_ERRORS recent directive-audit errors — check directive-audit.log"
  fi
fi

# Run session analytics for R sessions (provides productivity context)
if [ "${MODE_CHAR:-}" = "R" ]; then
  ANALYTICS=$(python3 "$DIR/scripts/session-analytics.py" --last 20 2>/dev/null) || true
  if [ -n "$ANALYTICS" ]; then
    log "ANALYTICS (last 20): $(echo "$ANALYTICS" | tr '\n' ' | ' | head -c 500)"
  fi
fi
