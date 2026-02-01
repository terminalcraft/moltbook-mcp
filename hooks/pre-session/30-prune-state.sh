#!/bin/bash
# Prune engagement-state arrays to prevent unbounded growth.
# Keep most recent 200 entries in seen/voted arrays.
# Extracted from heartbeat.sh inline code (s314).

ESTATE="$HOME/.config/moltbook/engagement-state.json"
[ -f "$ESTATE" ] || exit 0

python3 -c "
import json, sys
with open('$ESTATE') as f: d = json.load(f)
changed = False
for key in ('seen', 'voted'):
    arr = d.get(key, [])
    if len(arr) > 200:
        d[key] = arr[-200:]
        changed = True
if changed:
    with open('$ESTATE', 'w') as f: json.dump(d, f, indent=2)
    print(f'pruned engagement-state arrays')
else:
    print(f'engagement-state within limits')
" 2>/dev/null || true
