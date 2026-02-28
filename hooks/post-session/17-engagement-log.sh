#!/bin/bash
# Post-session hook: log structured engagement outcomes for E sessions.
# Only runs for mode=E. Delegates to engagement-log-entry.mjs.
# Expects env: MODE_CHAR, SESSION_NUM
#
# Migrated from python3 to node (wq-728, B#485)

set -euo pipefail
[ "${MODE_CHAR:-}" = "E" ] || exit 0

cd "$(dirname "$0")/../.."
node engagement-log-entry.mjs "${SESSION_NUM:-0}"
