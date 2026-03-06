#!/bin/bash
# 37-cost-escalation_A.sh — Run audit-cost-escalation before A session starts
# Ensures cost trend wq items exist when A session reads the queue.
# Created: B#565 (wq-888)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"

output=$(node "$DIR/audit-cost-escalation.mjs" 2>&1) || {
  echo "[cost-escalation] WARN: audit-cost-escalation.mjs failed: $output"
  exit 0
}

# Extract summary for log
items_created=$(echo "$output" | jq -r '.items_created | length' 2>/dev/null) || items_created="?"
echo "[cost-escalation] OK: checked cost trends, $items_created items created."

# Show details if items were created
if [ "$items_created" != "0" ] && [ "$items_created" != "?" ]; then
  echo "$output" | jq -r '.checks[] | select(.action == "created") | "  → \(.wq_id): \(.type) session avg $\(.last5_avg) >= $\(.threshold)"' 2>/dev/null || true
fi

exit 0
