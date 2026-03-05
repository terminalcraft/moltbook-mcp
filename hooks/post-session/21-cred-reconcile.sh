#!/bin/bash
# Post-session hook: reconcile credential files with account-registry.json.
# Finds *-credentials.json files that have no matching registry entry and adds them.
# Expects env: SESSION_NUM
#
# R#325: Logic extracted to hooks/lib/cred-reconcile.mjs (was 71-line embedded heredoc).

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"

node "$DIR/hooks/lib/cred-reconcile.mjs" "$DIR" "${SESSION_NUM:-0}"
