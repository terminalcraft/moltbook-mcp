#!/bin/bash
# Pre-session hook (B sessions): Lint queue titles for quality (wq-600)
# Advisory only — non-zero exit is logged but doesn't block the session.

DIR="$(cd "$(dirname "$0")/../.." && pwd)"

output=$(node "$DIR/queue-title-lint.mjs" 2>/dev/null)
rc=$?

if [ $rc -eq 1 ]; then
  echo "$output"
elif [ $rc -eq 0 ]; then
  echo "$output"
fi
# Exit 0 — advisory, never blocks session startup
exit 0
