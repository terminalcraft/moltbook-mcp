#!/bin/bash
# Pre-hook: Directive lifecycle cleanup detector (wq-153)
# Scans session files for references to completed directives and flags them
# for cleanup. Outputs warnings to session context.

set -euo pipefail

DIR="$HOME/moltbook-mcp"
STATE_DIR="$HOME/.config/moltbook"
OUTPUT_FILE="$STATE_DIR/directive-cruft.json"
DIRECTIVES="$DIR/directives.json"
SESSION_NUM="${SESSION_NUM:-0}"

mkdir -p "$STATE_DIR"

# wq-705: Replaced python3 with bash+jq for directive cleanup detection

if [ "$SESSION_NUM" -eq 0 ]; then
  exit 0
fi

# Load directive IDs and completed IDs
if ! ALL_IDS=$(jq -r '[.directives[]?.id // empty] | .[]' "$DIRECTIVES" 2>/dev/null); then
  echo "DIRECTIVE_CLEANUP: Cannot read directives.json"
  exit 0
fi

COMPLETED_IDS=$(jq -r '[.directives[]? | select(.status == "completed") | .id] | .[]' "$DIRECTIVES" 2>/dev/null)

if [ -z "$COMPLETED_IDS" ]; then
  echo "DIRECTIVE_CLEANUP: No completed directives to check"
  exit 0
fi

# Files to scan
SESSION_FILES="SESSION_BUILD.md SESSION_ENGAGE.md SESSION_REFLECT.md SESSION_AUDIT.md BRIEFING.md BRAINSTORMING.md"

# Build ID sets as JSON arrays (one jq call instead of line-by-line grep)
ALL_IDS_JSON=$(echo "$ALL_IDS" | jq -R . | jq -s '.')
COMPLETED_JSON=$(echo "$COMPLETED_IDS" | jq -R . | jq -s 'sort')

# Collect all grep matches across all files in one pass per file
# Format: file:linenum:directive_id — then process everything in a single jq call
TMP_MATCHES=$(mktemp)
trap 'rm -f "$TMP_MATCHES" 2>/dev/null' EXIT

for fname in $SESSION_FILES; do
  fpath="$DIR/$fname"
  [ -f "$fpath" ] || continue
  # Single grep per file: outputs "linenum:d0XX" for each match
  # || true: grep returns 1 when no matches — not an error under set -eo pipefail
  { grep -noP '\bd\d{3}\b' "$fpath" 2>/dev/null || true; } | while IFS=: read -r lnum did; do
    [ -z "$lnum" ] && continue
    # Get snippet for context (read specific line with sed)
    snippet=$(sed -n "${lnum}p" "$fpath" | sed 's/^[[:space:]]*//' | head -c 100)
    printf '%s\t%s\t%s\t%s\n' "$fname" "$lnum" "$did" "$snippet"
  done
done > "$TMP_MATCHES"

# Process all matches in a single jq invocation
jq -n -R --argjson session "$SESSION_NUM" \
  --argjson completed "$COMPLETED_JSON" \
  --argjson all_ids "$ALL_IDS_JSON" '
  ($completed | map(.) | INDEX(.; .)) as $comp_set |
  ($all_ids | map(.) | INDEX(.; .)) as $all_set |
  [inputs | split("\t") | {file: .[0], line: (.[1] | tonumber), directive: .[2], snippet: .[3]}] |
  group_by(.directive) | map(unique_by([.file, .line, .directive])) | flatten |
  reduce .[] as $m (
    {cruft: [], stale: []};
    if ($comp_set | has($m.directive)) then
      .cruft += [$m + {reason: "completed"}]
    elif ($all_set | has($m.directive) | not) then
      .stale += [$m + {reason: "non-existent"}]
    else . end
  ) |
  {
    session: $session,
    completed_directives: $completed,
    references_to_completed: .cruft,
    references_to_nonexistent: .stale,
    total_cruft: ((.cruft | length) + (.stale | length))
  }
' < "$TMP_MATCHES" > "$OUTPUT_FILE"

CRUFT_COUNT=$(jq '.references_to_completed | length' "$OUTPUT_FILE")
STALE_COUNT=$(jq '.references_to_nonexistent | length' "$OUTPUT_FILE")
TOTAL_CRUFT=$((CRUFT_COUNT + STALE_COUNT))

# Output summary
if [ "$TOTAL_CRUFT" -gt 0 ]; then
  echo "DIRECTIVE_CLEANUP: $TOTAL_CRUFT stale reference(s) found"

  if [ "$CRUFT_COUNT" -gt 0 ]; then
    jq -r '.references_to_completed | group_by(.file) | .[] | "  - \(.[0].file): \([.[].directive] | unique | sort | join(", ")) (completed)"' \
      "$OUTPUT_FILE" 2>/dev/null
  fi
  if [ "$STALE_COUNT" -gt 0 ]; then
    jq -r '.references_to_nonexistent | group_by(.file) | .[] | "  - \(.[0].file): \([.[].directive] | unique | sort | join(", ")) (non-existent)"' \
      "$OUTPUT_FILE" 2>/dev/null
  fi
  echo "  Details: ~/.config/moltbook/directive-cruft.json"
else
  echo "DIRECTIVE_CLEANUP: No stale directive references in session files"
fi
