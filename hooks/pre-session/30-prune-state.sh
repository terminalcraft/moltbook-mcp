#!/bin/bash
# Prune engagement-state arrays to prevent unbounded growth.
# Keep most recent 200 entries in seen/voted arrays.
# Extracted from heartbeat.sh inline code (s314).

ESTATE="$HOME/.config/moltbook/engagement-state.json"
[ -f "$ESTATE" ] || exit 0

# wq-705: Replaced python3 with jq for JSON parsing
# seen/voted can be arrays OR objects (keyed by UUID with .at timestamps)
NEEDS_PRUNE=$(jq '
  ((.seen // {}) | if type == "array" then length else (length) end) > 200 or
  ((.voted // {}) | if type == "array" then length else (length) end) > 200
' "$ESTATE" 2>/dev/null || echo "false")

if [ "$NEEDS_PRUNE" = "true" ]; then
  TMP=$(mktemp)
  jq '
    # Handle both array and object formats for seen/voted
    # Values can be strings, objects with .at, or other types
    def prune_to(n):
      if type == "array" then .[-n:]
      elif type == "object" then
        if length > n then
          [to_entries[] | . + {sort_key: (
            if .value | type == "object" then (.value.at // .key)
            elif .value | type == "string" then .value
            else .key end
          )}] |
          sort_by(.sort_key) | .[-n:] | del(.[].sort_key) | from_entries
        else . end
      else . end;
    .seen = (.seen // {} | prune_to(200)) |
    .voted = (.voted // {} | prune_to(200))
  ' "$ESTATE" > "$TMP" && mv "$TMP" "$ESTATE"
  echo "pruned engagement-state arrays"
else
  echo "engagement-state within limits"
fi
