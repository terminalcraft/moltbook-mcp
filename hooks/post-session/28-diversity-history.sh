#!/bin/bash
# 28-diversity-history.sh — Records engagement diversity metrics after E sessions (wq-131)
# Enables trend analysis by A sessions.

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
HISTORY_FILE="$STATE_DIR/diversity-history.json"

# Only run after E sessions
MODE="${SESSION_MODE:-}"
if [ "$MODE" != "E" ]; then
  exit 0
fi

SESSION="${SESSION_NUM:-0}"

# Get current diversity metrics from engage-orchestrator
METRICS=$(node "$DIR/engage-orchestrator.mjs" --diversity --json 2>/dev/null || echo '{}')

# Extract key fields
HHI=$(echo "$METRICS" | python3 -c "import json,sys; d=json.load(sys.stdin).get('diversity',{}); print(d.get('hhi_writes',0))" 2>/dev/null || echo "0")
EFF=$(echo "$METRICS" | python3 -c "import json,sys; d=json.load(sys.stdin).get('diversity',{}); print(d.get('effective_platforms_writes',0))" 2>/dev/null || echo "0")
TOP1=$(echo "$METRICS" | python3 -c "import json,sys; d=json.load(sys.stdin).get('diversity',{}); print(d.get('top1_pct',0))" 2>/dev/null || echo "0")
TOP3=$(echo "$METRICS" | python3 -c "import json,sys; d=json.load(sys.stdin).get('diversity',{}); print(d.get('top3_pct',0))" 2>/dev/null || echo "0")
COUNT=$(echo "$METRICS" | python3 -c "import json,sys; d=json.load(sys.stdin).get('diversity',{}); print(d.get('platform_count',0))" 2>/dev/null || echo "0")

# Append to history (JSONL format)
{
  echo -n "{\"session\":$SESSION,\"ts\":\"$(date -Iseconds)\","
  echo -n "\"hhi\":$HHI,\"effective_platforms\":$EFF,"
  echo -n "\"top1_pct\":$TOP1,\"top3_pct\":$TOP3,"
  echo "\"platform_count\":$COUNT}"
} >> "$HISTORY_FILE"

# Keep last 100 entries
if [ "$(wc -l < "$HISTORY_FILE" 2>/dev/null || echo 0)" -gt 100 ]; then
  tail -100 "$HISTORY_FILE" > "$HISTORY_FILE.tmp" && mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"
fi

echo "[diversity-history] Recorded E session $SESSION: HHI=$HHI, eff=$EFF, top1=$TOP1%"
