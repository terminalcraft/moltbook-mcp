#!/bin/bash
# Pre-session: track SESSION_*.md line counts and flag cognitive load issues
# Created by B#196 (wq-152)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT="$DIR/session-file-sizes.json"
THRESHOLD=150  # Lines threshold for cognitive load warning

# Count lines in each SESSION_*.md file
declare -A sizes
max_file=""
max_lines=0
warnings=""

for f in "$DIR"/SESSION_*.md; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  lines=$(wc -l < "$f")
  sizes[$name]=$lines

  if [ "$lines" -gt "$max_lines" ]; then
    max_lines=$lines
    max_file=$name
  fi

  if [ "$lines" -gt "$THRESHOLD" ]; then
    warnings="${warnings:+$warnings, }$name ($lines lines)"
  fi
done

# Write JSON output
{
  echo "{"
  echo "  \"timestamp\": \"$(date -Iseconds)\","
  echo "  \"session\": ${SESSION_NUM:-0},"
  echo "  \"threshold\": $THRESHOLD,"
  echo "  \"files\": {"
  first=true
  for name in "${!sizes[@]}"; do
    $first || echo ","
    first=false
    printf '    "%s": %d' "$name" "${sizes[$name]}"
  done
  echo ""
  echo "  },"
  echo "  \"max_file\": \"$max_file\","
  echo "  \"max_lines\": $max_lines,"
  if [ -n "$warnings" ]; then
    echo "  \"warning\": \"Files exceeding threshold: $warnings\""
  else
    echo "  \"warning\": null"
  fi
  echo "}"
} > "$OUTPUT"

# Log warning if any files exceed threshold
if [ -n "$warnings" ]; then
  echo "SESSION_FILE_SIZE_WARNING: $warnings (threshold: $THRESHOLD lines)" >&2
fi
