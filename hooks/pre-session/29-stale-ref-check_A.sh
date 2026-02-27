#!/bin/bash
# 29-stale-ref-check_A.sh — Automated stale-reference detection for A sessions
#
# Runs stale-ref-check.sh and writes structured results to stale-refs.json
# for the audit report to consume. Makes stale-reference detection fully automated
# (previously done manually during A sessions).
#
# Created: B#390 s1372 (wq-508)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
OUTPUT_FILE="$STATE_DIR/stale-refs.json"

# Run stale-ref-check.sh and capture output
RAW_OUTPUT=$("$DIR/stale-ref-check.sh" 2>/dev/null) || {
  # Script failed — write empty result, don't block session
  echo '{"checked":"'"$(date -Iseconds)"'","session":'"${SESSION_NUM:-0}"',"stale_count":0,"stale_refs":[],"error":"stale-ref-check.sh failed"}' > "$OUTPUT_FILE"
  exit 0
}

# wq-705: Replaced python3 with bash+jq for output parsing
SESSION="${SESSION_NUM:-0}"
CHECKED=$(date -Iseconds)
STALE_REFS="[]"
CURRENT_FILE=""
TMP_REFS=$(mktemp)
echo "[]" > "$TMP_REFS"

while IFS= read -r line; do
  line=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -z "$line" ] && continue

  if echo "$line" | grep -q '^STALE:'; then
    CURRENT_FILE=$(echo "$line" | grep -oP 'STALE:\s+\K\S+')
  elif [ -n "$CURRENT_FILE" ] && ! echo "$line" | grep -qE '^(===|No |All )'; then
    # Reference line
    jq --arg df "$CURRENT_FILE" --arg ri "$line" '. += [{"deleted_file": $df, "referenced_in": $ri}]' "$TMP_REFS" > "${TMP_REFS}.tmp" && mv "${TMP_REFS}.tmp" "$TMP_REFS"
  fi
done <<< "$RAW_OUTPUT"

STALE_COUNT=$(jq 'length' "$TMP_REFS")
HAS_STALE=$([ "$STALE_COUNT" -gt 0 ] && echo "true" || echo "false")

jq -n --arg checked "$CHECKED" --argjson session "$SESSION" --argjson count "$STALE_COUNT" \
  --slurpfile refs "$TMP_REFS" --argjson has_stale "$HAS_STALE" \
  '{checked: $checked, session: $session, stale_count: $count, stale_refs: $refs[0], has_stale: $has_stale}' > "$OUTPUT_FILE"

rm -f "$TMP_REFS"

# Output summary
if [ "$STALE_COUNT" -gt 0 ]; then
  FILE_COUNT=$(jq '[.[].deleted_file] | unique | length' <<< "$(jq '.' "$OUTPUT_FILE" | jq '.stale_refs')")
  echo "stale-ref-check: $STALE_COUNT stale reference(s) in $FILE_COUNT deleted file(s)"
else
  echo "stale-ref-check: clean (0 stale references)"
fi

exit 0
