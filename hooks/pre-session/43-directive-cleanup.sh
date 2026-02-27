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

TMP_CRUFT=$(mktemp)
TMP_STALE=$(mktemp)
echo "[]" > "$TMP_CRUFT"
echo "[]" > "$TMP_STALE"

for fname in $SESSION_FILES; do
  fpath="$DIR/$fname"
  [ -f "$fpath" ] || continue

  # Search for directive references (d001, d002, etc.)
  LINENO=0
  while IFS= read -r line; do
    LINENO=$((LINENO + 1))
    # Extract all d### patterns from this line
    MATCHES=$(echo "$line" | grep -oP '\bd\d{3}\b' | sort -u)
    for did in $MATCHES; do
      SNIPPET=$(echo "$line" | sed 's/^[[:space:]]*//' | head -c 100)

      if echo "$COMPLETED_IDS" | grep -qx "$did"; then
        jq --arg f "$fname" --argjson l "$LINENO" --arg d "$did" --arg s "$SNIPPET" \
          '. += [{"file": $f, "line": $l, "directive": $d, "reason": "completed", "snippet": $s}]' \
          "$TMP_CRUFT" > "${TMP_CRUFT}.tmp" && mv "${TMP_CRUFT}.tmp" "$TMP_CRUFT"
      elif ! echo "$ALL_IDS" | grep -qx "$did"; then
        jq --arg f "$fname" --argjson l "$LINENO" --arg d "$did" --arg s "$SNIPPET" \
          '. += [{"file": $f, "line": $l, "directive": $d, "reason": "non-existent", "snippet": $s}]' \
          "$TMP_STALE" > "${TMP_STALE}.tmp" && mv "${TMP_STALE}.tmp" "$TMP_STALE"
      fi
    done
  done < "$fpath"
done

CRUFT_COUNT=$(jq 'length' "$TMP_CRUFT")
STALE_COUNT=$(jq 'length' "$TMP_STALE")
TOTAL_CRUFT=$((CRUFT_COUNT + STALE_COUNT))

# Build completed list for report
COMPLETED_JSON=$(echo "$COMPLETED_IDS" | jq -R . | jq -s 'sort')

# Write report
jq -n --argjson session "$SESSION_NUM" --argjson completed "$COMPLETED_JSON" \
  --slurpfile cruft "$TMP_CRUFT" --slurpfile stale "$TMP_STALE" --argjson total "$TOTAL_CRUFT" \
  '{session: $session, completed_directives: $completed, references_to_completed: $cruft[0], references_to_nonexistent: $stale[0], total_cruft: $total}' > "$OUTPUT_FILE"

rm -f "$TMP_CRUFT" "$TMP_STALE"

# Output summary
if [ "$TOTAL_CRUFT" -gt 0 ]; then
  echo "DIRECTIVE_CLEANUP: $TOTAL_CRUFT stale reference(s) found"

  if [ "$CRUFT_COUNT" -gt 0 ]; then
    jq -r 'group_by(.file) | .[] | "  - \(.[0].file): \([.[].directive] | unique | sort | join(", ")) (completed)"' \
      < <(jq '.' "$OUTPUT_FILE" | jq '.references_to_completed') 2>/dev/null
  fi
  if [ "$STALE_COUNT" -gt 0 ]; then
    jq -r 'group_by(.file) | .[] | "  - \(.[0].file): \([.[].directive] | unique | sort | join(", ")) (non-existent)"' \
      < <(jq '.references_to_nonexistent' "$OUTPUT_FILE") 2>/dev/null
  fi
  echo "  Details: ~/.config/moltbook/directive-cruft.json"
else
  echo "DIRECTIVE_CLEANUP: No stale directive references in session files"
fi
