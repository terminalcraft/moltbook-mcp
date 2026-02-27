#!/bin/bash
# Prune engagement-state arrays to prevent unbounded growth.
# Keep most recent 200 entries in seen/voted arrays.
# Extracted from heartbeat.sh inline code (s314).

ESTATE="$HOME/.config/moltbook/engagement-state.json"
[ -f "$ESTATE" ] || exit 0

# wq-705: Replaced python3 with jq for JSON parsing
NEEDS_PRUNE=$(jq '
  (.seen // [] | length > 200) or (.voted // [] | length > 200)
' "$ESTATE" 2>/dev/null || echo "false")

if [ "$NEEDS_PRUNE" = "true" ]; then
  TMP=$(mktemp)
  jq '.seen = (.seen // [] | .[-200:]) | .voted = (.voted // [] | .[-200:])' "$ESTATE" > "$TMP" && mv "$TMP" "$ESTATE"
  echo "pruned engagement-state arrays"
else
  echo "engagement-state within limits"
fi
