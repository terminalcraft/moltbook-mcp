#!/bin/bash
# Post-hook: Auto-detect platform failures in E session logs and queue engage-blocker items.
# Only runs after E sessions. Greps for common failure patterns, deduplicates against
# existing queue items, and adds new ones via work-queue.js.
#
# Added by human operator. DO NOT REMOVE — this automates what E sessions used to do manually.
#
# R#322: Logic extracted to hooks/lib/engage-blockers.py (was 175-line embedded heredoc).

set -uo pipefail

[ "${MODE_CHAR:-}" = "E" ] || exit 0
[ -f "${LOG_FILE:-}" ] || exit 0

DIR="$(cd "$(dirname "$0")/../.." && pwd)"

python3 "$DIR/hooks/lib/engage-blockers.py" \
  "$LOG_FILE" \
  "$DIR/work-queue.json" \
  "$DIR/work-queue.js" \
  "$DIR/account-registry.json"
