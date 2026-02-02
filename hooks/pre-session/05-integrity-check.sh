#!/bin/bash
# Pre-session: validate checksums of critical files
# Detects unexpected modifications to BRIEFING.md, heartbeat.sh, base-prompt.md
# If no checksum file exists, generates one (first run). If mismatch, logs warning.
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CHECKSUM_FILE="$HOME/.config/moltbook/integrity-checksums.sha256"
LOG="$HOME/.config/moltbook/logs/integrity.log"

CRITICAL_FILES=(
  "$DIR/BRIEFING.md"
  "$DIR/heartbeat.sh"
  "$DIR/base-prompt.md"
  "$DIR/index.js"
  "$DIR/SESSION_BUILD.md"
  "$DIR/SESSION_ENGAGE.md"
  "$DIR/SESSION_REFLECT.md"
)

# Generate checksums if file doesn't exist
if [ ! -f "$CHECKSUM_FILE" ]; then
  for f in "${CRITICAL_FILES[@]}"; do
    [ -f "$f" ] && sha256sum "$f"
  done > "$CHECKSUM_FILE"
  echo "[$(date -Is)] integrity: initialized checksums for ${#CRITICAL_FILES[@]} files" >> "$LOG"
  exit 0
fi

# Validate existing checksums
CHANGED=()
for f in "${CRITICAL_FILES[@]}"; do
  [ -f "$f" ] || continue
  STORED=$(grep -F "$f" "$CHECKSUM_FILE" | awk '{print $1}')
  [ -z "$STORED" ] && continue
  CURRENT=$(sha256sum "$f" | awk '{print $1}')
  if [ "$STORED" != "$CURRENT" ]; then
    CHANGED+=("$f")
  fi
done

if [ ${#CHANGED[@]} -gt 0 ]; then
  echo "[$(date -Is)] integrity: WARNING — ${#CHANGED[@]} file(s) changed since last checkpoint:" >> "$LOG"
  for f in "${CHANGED[@]}"; do
    echo "  - $f" >> "$LOG"
  done
  # Export for session awareness
  export INTEGRITY_WARNINGS="${CHANGED[*]}"
  echo "INTEGRITY_WARN=${#CHANGED[@]}" >> "$HOME/.config/moltbook/session-env.sh" 2>/dev/null || true
else
  echo "[$(date -Is)] integrity: all ${#CRITICAL_FILES[@]} files OK" >> "$LOG"
fi
exit 0
