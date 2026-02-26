#!/bin/bash
# cron-knowbster-analytics.sh — Weekly Knowbster analytics snapshot.
# Captures collection analytics and appends to history file for trend tracking.
#
# Install: crontab -e → 0 6 * * 1 /home/moltbot/moltbook-mcp/cron-knowbster-analytics.sh
# (Runs Monday 6 AM UTC)
#
# Output: ~/.config/moltbook/knowbster-analytics-history.json
#
# Created: B#464 (wq-675)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HISTORY_FILE="$HOME/.config/moltbook/knowbster-analytics-history.json"
PUBLISHED_FILE="$HOME/.config/moltbook/knowbster-published.json"
COLLECTIONS_FILE="$SCRIPT_DIR/knowbster-collections.json"

mkdir -p "$(dirname "$HISTORY_FILE")"

# Exit early if no published collections exist
if [ ! -f "$PUBLISHED_FILE" ] || [ "$(jq 'length' "$PUBLISHED_FILE" 2>/dev/null)" = "0" ] || [ "$(jq 'length' "$PUBLISHED_FILE" 2>/dev/null)" = "null" ]; then
  echo "[knowbster-cron] No published collections, skipping."
  exit 0
fi

# Also check collections definition exists
if [ ! -f "$COLLECTIONS_FILE" ]; then
  echo "[knowbster-cron] No collections definition file, skipping."
  exit 0
fi

# Run analytics, capture output (timeout 60s to prevent hangs)
ANALYTICS_OUTPUT=$(timeout 60 node "$SCRIPT_DIR/knowbster-collection.mjs" --analytics 2>&1) || true

# Extract key metrics from text output using simple parsing
# Lines like "  Total sales: N" and "  Total revenue: X ETH"
TOTAL_SALES=$(echo "$ANALYTICS_OUTPUT" | grep -oP 'Grand total sales: \K\d+' 2>/dev/null || echo "0")
TOTAL_REVENUE=$(echo "$ANALYTICS_OUTPUT" | grep -oP 'Grand total revenue: \K[\d.]+' 2>/dev/null || echo "0")
COLLECTION_COUNT=$(echo "$ANALYTICS_OUTPUT" | grep -oP 'Collections analyzed: \K\d+' 2>/dev/null || echo "0")

# Build snapshot entry
SNAPSHOT=$(jq -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson sales "${TOTAL_SALES:-0}" \
  --arg revenue "${TOTAL_REVENUE:-0}" \
  --argjson collections "${COLLECTION_COUNT:-0}" \
  '{
    ts: $ts,
    totalSales: $sales,
    totalRevenue: $revenue,
    collectionsAnalyzed: $collections
  }')

# Append to history file (create if missing, cap at 52 weeks)
if [ -f "$HISTORY_FILE" ] && jq empty "$HISTORY_FILE" 2>/dev/null; then
  jq --argjson entry "$SNAPSHOT" '
    .entries += [$entry] |
    if (.entries | length) > 52 then .entries = .entries[-52:] else . end
  ' "$HISTORY_FILE" > "$HISTORY_FILE.tmp" && mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"
else
  echo "{\"entries\":[$SNAPSHOT]}" | jq '.' > "$HISTORY_FILE"
fi

echo "[knowbster-cron] Snapshot saved: sales=$TOTAL_SALES revenue=$TOTAL_REVENUE collections=$COLLECTION_COUNT"
