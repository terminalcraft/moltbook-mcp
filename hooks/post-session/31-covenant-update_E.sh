#!/bin/bash
# 31-covenant-update_E.sh — Update covenant tracking after E sessions (wq-220)
# The _E suffix means this only runs for E sessions (post-session hook convention).
# Covenants track consistent mutual engagement patterns across sessions.

cd "$(dirname "$0")/../.." || exit 0

# Update covenants from engagement trace
node covenant-tracker.mjs update >/dev/null 2>&1

exit 0
