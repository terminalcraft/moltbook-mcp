#!/bin/bash
# Chatr digest snapshot — called by cron or manually.
# Fetches signal-filtered digest from local API, stores in snapshots dir.
# Keeps last 24 snapshots (one per 6-hour run = 6 days of history).

set -euo pipefail

SNAP_DIR="$HOME/.config/moltbook/chatr-snapshots"
API="http://localhost:3847/chatr/digest?limit=30&mode=signal"
MAX_SNAPSHOTS=24

mkdir -p "$SNAP_DIR"

TS=$(date -u +%Y%m%d-%H%M)
OUTFILE="$SNAP_DIR/digest-$TS.json"

# Fetch digest
HTTP_CODE=$(curl -s -o "$OUTFILE" -w "%{http_code}" "$API" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" != "200" ]; then
  rm -f "$OUTFILE"
  echo "CHATR_SNAP: Failed (HTTP $HTTP_CODE)"
  exit 1
fi

# Prune old snapshots
ls -1t "$SNAP_DIR"/digest-*.json 2>/dev/null | tail -n +$((MAX_SNAPSHOTS + 1)) | xargs -r rm -f

COUNT=$(ls -1 "$SNAP_DIR"/digest-*.json 2>/dev/null | wc -l)
echo "CHATR_SNAP: Saved $OUTFILE ($COUNT snapshots total)"
