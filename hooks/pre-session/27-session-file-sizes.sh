#!/bin/bash
# Pre-session: track session file line counts and flag cognitive load issues
# Created by B#196 (wq-152), expanded by B#198 (wq-155)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT="$DIR/session-file-sizes.json"
HISTORY="$DIR/session-file-sizes-history.json"
THRESHOLD=150  # Lines threshold for cognitive load warning
HISTORY_LIMIT=50  # Keep last N snapshots for trend analysis

# Count lines in session files (SESSION_*.md + BRIEFING.md + pinchwork-protocol.md)
declare -A sizes
max_file=""
max_lines=0
warnings=""
total_lines=0

# Track SESSION_*.md files
for f in "$DIR"/SESSION_*.md; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  lines=$(wc -l < "$f")
  sizes[$name]=$lines
  total_lines=$((total_lines + lines))

  if [ "$lines" -gt "$max_lines" ]; then
    max_lines=$lines
    max_file=$name
  fi

  if [ "$lines" -gt "$THRESHOLD" ]; then
    warnings="${warnings:+$warnings, }$name ($lines lines)"
  fi
done

# Track BRIEFING.md
if [ -f "$DIR/BRIEFING.md" ]; then
  lines=$(wc -l < "$DIR/BRIEFING.md")
  sizes["BRIEFING.md"]=$lines
  total_lines=$((total_lines + lines))
  if [ "$lines" -gt "$THRESHOLD" ]; then
    warnings="${warnings:+$warnings, }BRIEFING.md ($lines lines)"
  fi
fi

# Track extracted protocol files
if [ -f "$DIR/pinchwork-protocol.md" ]; then
  lines=$(wc -l < "$DIR/pinchwork-protocol.md")
  sizes["pinchwork-protocol.md"]=$lines
  total_lines=$((total_lines + lines))
fi

# Build current snapshot JSON
current_snapshot=$(cat <<EOF
{
  "timestamp": "$(date -Iseconds)",
  "session": ${SESSION_NUM:-0},
  "threshold": $THRESHOLD,
  "files": {
$(first=true; for name in "${!sizes[@]}"; do $first || echo ","; first=false; printf '    "%s": %d' "$name" "${sizes[$name]}"; done)
  },
  "total_lines": $total_lines,
  "max_file": "$max_file",
  "max_lines": $max_lines,
  "warning": $([ -n "$warnings" ] && echo "\"Files exceeding threshold: $warnings\"" || echo "null")
}
EOF
)

# Write current snapshot
echo "$current_snapshot" > "$OUTPUT"

# Append to history (maintain last N entries)
if [ -f "$HISTORY" ]; then
  # Read existing history, append new entry, keep last N
  node -e "
    const fs = require('fs');
    const history = JSON.parse(fs.readFileSync('$HISTORY', 'utf8'));
    const snapshot = JSON.parse(\`$current_snapshot\`);
    history.snapshots.push(snapshot);
    if (history.snapshots.length > $HISTORY_LIMIT) {
      history.snapshots = history.snapshots.slice(-$HISTORY_LIMIT);
    }
    fs.writeFileSync('$HISTORY', JSON.stringify(history, null, 2));
  " 2>/dev/null || true
else
  # Initialize history file
  node -e "
    const fs = require('fs');
    const snapshot = JSON.parse(\`$current_snapshot\`);
    const history = { version: 1, snapshots: [snapshot] };
    fs.writeFileSync('$HISTORY', JSON.stringify(history, null, 2));
  " 2>/dev/null || true
fi

# Log warning if any files exceed threshold
if [ -n "$warnings" ]; then
  echo "SESSION_FILE_SIZE_WARNING: $warnings (threshold: $THRESHOLD lines)" >&2
fi
