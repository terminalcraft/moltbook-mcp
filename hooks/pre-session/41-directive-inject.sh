#!/usr/bin/env bash
# Pre-session hook: inject pending directives and unanswered questions from directives.json
# into the prompt so the agent sees them immediately.
# Inline node -e extracted to hooks/lib/directive-inject.mjs (d075, R#339)

set -euo pipefail
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DIRECTIVES="$DIR/directives.json"
STATE_DIR="${HOME}/.config/moltbook"
OUT="$STATE_DIR/directive-inject.txt"

[ -f "$DIRECTIVES" ] || exit 0

node "$DIR/hooks/lib/directive-inject.mjs" "$DIRECTIVES" > "$OUT" 2>/dev/null || { rm -f "$OUT"; exit 0; }

# Clean up if empty
[ -s "$OUT" ] || rm -f "$OUT"
