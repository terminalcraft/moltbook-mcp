#!/bin/bash
# Bluesky agent discovery auto-scan
# Run via cron every 12 hours. Saves catalog + logs deltas.
# Usage: bsky-autoscan.sh [--post-new]

DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$HOME/.config/moltbook/logs"
LOG_FILE="$LOG_DIR/bsky-scan.log"
CATALOG="$DIR/bsky-agents.json"
PREV_CATALOG="$DIR/bsky-agents.prev.json"

mkdir -p "$LOG_DIR"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"; }

log "Starting auto-scan"

# Save previous catalog for diff
if [ -f "$CATALOG" ]; then
  cp "$CATALOG" "$PREV_CATALOG"
fi

# Run discovery with JSON output
cd "$DIR"
node bsky-discover.cjs --json --limit 50 --min-score 20 > /dev/null 2>> "$LOG_FILE"
EXIT=$?

if [ $EXIT -ne 0 ]; then
  log "ERROR: bsky-discover exited with code $EXIT"
  exit $EXIT
fi

# Compute delta
if [ -f "$PREV_CATALOG" ] && [ -f "$CATALOG" ]; then
  PREV_HANDLES=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$PREV_CATALOG','utf8')).map(a=>a.handle).sort().join('\n'))")
  CURR_HANDLES=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CATALOG','utf8')).map(a=>a.handle).sort().join('\n'))")

  NEW_AGENTS=$(comm -13 <(echo "$PREV_HANDLES") <(echo "$CURR_HANDLES"))
  GONE_AGENTS=$(comm -23 <(echo "$PREV_HANDLES") <(echo "$CURR_HANDLES"))

  TOTAL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CATALOG','utf8')).length)")

  if [ -n "$NEW_AGENTS" ]; then
    NEW_COUNT=$(echo "$NEW_AGENTS" | wc -l)
    log "NEW ($NEW_COUNT): $NEW_AGENTS"
  fi
  if [ -n "$GONE_AGENTS" ]; then
    GONE_COUNT=$(echo "$GONE_AGENTS" | wc -l)
    log "GONE ($GONE_COUNT): $GONE_AGENTS"
  fi
  if [ -z "$NEW_AGENTS" ] && [ -z "$GONE_AGENTS" ]; then
    log "No changes. $TOTAL agents tracked."
  else
    log "Catalog updated. $TOTAL agents tracked."
  fi

  rm -f "$PREV_CATALOG"
else
  TOTAL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CATALOG','utf8')).length)" 2>/dev/null || echo "?")
  log "First scan. $TOTAL agents cataloged."
fi

# Regenerate unified cross-platform agent catalog
node "$DIR/collect-agents.cjs" >> "$LOG_FILE" 2>&1
log "Auto-scan complete"
