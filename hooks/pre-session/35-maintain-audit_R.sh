#!/bin/bash
# Pre-session maintenance audit for R sessions.
# Replaces the manual maintain checklist — runs automatically and logs warnings.
# Only runs on R sessions (enforced by _R.sh filename suffix since R#101).
# Added s383: retire evolve/maintain split, automate routine checks.

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
AUDIT_FILE="$HOME/.config/moltbook/maintain-audit.txt"

echo "=== Maintenance audit $(date -Iseconds) s=${SESSION_NUM:-?} ===" > "$AUDIT_FILE"

# 1. Security: check sensitive file permissions
ISSUES=0
for f in "$DIR/wallet.json" "$DIR/ctxly.json" "$DIR/.env" "$HOME/.config/moltbook/engagement-state.json"; do
  [ -f "$f" ] || continue
  PERMS=$(stat -c%a "$f" 2>/dev/null || echo "???")
  if [ "$PERMS" != "600" ]; then
    echo "WARN: $f has permissions $PERMS (expected 600)" >> "$AUDIT_FILE"
    ISSUES=$((ISSUES + 1))
  fi
done

# 2. Disk usage
DISK_PCT=$(df /home/moltbot --output=pcent | tail -1 | tr -d ' %')
if [ "$DISK_PCT" -gt 80 ]; then
  echo "WARN: Disk usage at ${DISK_PCT}%" >> "$AUDIT_FILE"
  ISSUES=$((ISSUES + 1))
fi

# 3. API health
if ! curl -sf http://localhost:3847/health > /dev/null 2>&1; then
  echo "WARN: API not responding on localhost:3847" >> "$AUDIT_FILE"
  ISSUES=$((ISSUES + 1))
fi

# 4. Log sizes
for logfile in "$HOME/.config/moltbook/logs"/*.log; do
  [ -f "$logfile" ] || continue
  SIZE=$(stat -c%s "$logfile" 2>/dev/null || echo 0)
  if [ "$SIZE" -gt 5242880 ]; then
    echo "WARN: $(basename "$logfile") is $(( SIZE / 1048576 ))MB" >> "$AUDIT_FILE"
    ISSUES=$((ISSUES + 1))
  fi
done

if [ "$ISSUES" -eq 0 ]; then
  echo "ALL CLEAR: security, disk, API, logs all healthy" >> "$AUDIT_FILE"
else
  echo "TOTAL: $ISSUES issue(s) flagged" >> "$AUDIT_FILE"
fi

echo "Maintain audit: $ISSUES issue(s)"
