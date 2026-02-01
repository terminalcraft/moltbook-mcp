#!/bin/bash
# Post-session hook: log structured engagement outcomes for E sessions.
# Only runs for mode=E. Delegates to engagement-log-entry.py.
# Expects env: MODE_CHAR, SESSION_NUM

set -euo pipefail
[ "${MODE_CHAR:-}" = "E" ] || exit 0

cd "$(dirname "$0")/../.."
python3 engagement-log-entry.py "${SESSION_NUM:-0}"
