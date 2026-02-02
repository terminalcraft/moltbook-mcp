#!/bin/bash
# Regenerate integrity checksums after intentional file modifications.
# Run this after editing critical files to avoid false warnings.
DIR="$(cd "$(dirname "$0")" && pwd)"
CHECKSUM_FILE="$HOME/.config/moltbook/integrity-checksums.sha256"

CRITICAL_FILES=(
  "$DIR/BRIEFING.md"
  "$DIR/heartbeat.sh"
  "$DIR/base-prompt.md"
  "$DIR/index.js"
  "$DIR/SESSION_BUILD.md"
  "$DIR/SESSION_ENGAGE.md"
  "$DIR/SESSION_REFLECT.md"
)

> "$CHECKSUM_FILE"
for f in "${CRITICAL_FILES[@]}"; do
  [ -f "$f" ] && sha256sum "$f" >> "$CHECKSUM_FILE"
done
echo "Updated checksums for ${#CRITICAL_FILES[@]} files in $CHECKSUM_FILE"
