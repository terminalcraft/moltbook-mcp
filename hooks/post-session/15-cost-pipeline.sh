#!/bin/bash
# Post-hook: Unified cost pipeline (consolidated from 15/18/19/21/23)
# Steps: log cost → detect anomalies → compute trends → check utilization → nudge
# Expects env: MODE_CHAR, SESSION_NUM, LOG_FILE

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
COST_FILE="$STATE_DIR/cost-history.json"
TREND_FILE="$STATE_DIR/cost-trends.json"
UTIL_FILE="$STATE_DIR/budget-utilization.json"
NUDGE_FILE="$STATE_DIR/budget-nudge.txt"
DIRECTIVE_FILE="$HOME/moltbook-mcp/directives.json"

mkdir -p "$STATE_DIR"

# Initialize cost history if missing
if [ ! -f "$COST_FILE" ]; then
  echo '[]' > "$COST_FILE"
fi

# === Step 1: Log cost ===
SPENT=""
SOURCE="none"
AGENT_COST_FILE="$STATE_DIR/session-cost.txt"

# Capture BOTH sources for dual-record accuracy tracking (wq-409)
DUAL_AGENT_COST=""
DUAL_TOKEN_COST=""

# Agent-reported cost: capture for dual-record only, NOT used as primary (wq-415)
# Agent-reported costs consistently diverge from token-calc (s1199: $7.97 reported vs ~$2.27 actual).
# Token-calc is authoritative. Agent-reported kept only for monitoring.
if [ -f "$AGENT_COST_FILE" ]; then
  AGENT_SPENT=$(grep -oP 'BUDGET_SPENT=\K[0-9.]+' "$AGENT_COST_FILE" 2>/dev/null || true)
  if [ -n "$AGENT_SPENT" ]; then
    DUAL_AGENT_COST="$AGENT_SPENT"
  fi
  rm -f "$AGENT_COST_FILE"
fi

# Primary: token-calc from session log (authoritative source, wq-415)
COST_JSON=$(python3 "$DIR/scripts/calc-session-cost.py" "$LOG_FILE" --json 2>/dev/null || true)
if [ -n "$COST_JSON" ]; then
  TOKEN_COST=$(echo "$COST_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{d[\"cost_usd\"]:.4f}')" 2>/dev/null || true)
  DUAL_TOKEN_COST="$TOKEN_COST"
  if [ -n "$TOKEN_COST" ] && echo "$TOKEN_COST" | awk '{exit ($1 >= 0.01) ? 0 : 1}'; then
    SPENT="$TOKEN_COST"
    SOURCE="token-calc"
  fi
fi

# Fallback: agent-reported cost (only if token-calc failed entirely)
if [ -z "$SPENT" ] || [ "$SPENT" = "0.0000" ]; then
  if [ -n "$DUAL_AGENT_COST" ]; then
    if echo "$DUAL_AGENT_COST" | awk '{exit ($1 >= 0.10) ? 0 : 1}'; then
      SPENT="$DUAL_AGENT_COST"
      SOURCE="agent-reported-fallback"
    fi
  fi
fi

if [ -z "$SPENT" ] || [ "$SPENT" = "0.0000" ]; then
  echo "$(date -Iseconds) cost-pipeline: no cost data found" >&2
  exit 0
fi

# Append to cost history
python3 -c "
import json
entry = {
    'date': '$(date -Iseconds)',
    'session': int('${SESSION_NUM:-0}'),
    'mode': '${MODE_CHAR:-?}',
    'cost': float('${SPENT}'),
    'source': '${SOURCE}'
}
data = json.load(open('$COST_FILE'))
data.append(entry)
data = data[-200:]
json.dump(data, open('$COST_FILE', 'w'))
"
echo "cost-pipeline: logged \$${SPENT} (${SOURCE}) mode=${MODE_CHAR:-?} s=${SESSION_NUM:-?}"

# === Pre-analysis: extract task context for anomaly enrichment (wq-418) ===
WQ_TASK_ID=""
if [ -f "$DIR/work-queue.json" ]; then
  # Get the most recently in-progress or done item (likely the assigned task)
  WQ_TASK_ID=$(python3 -c "
import json
try:
    wq = json.load(open('$DIR/work-queue.json'))
    # Find items done in this session or currently in-progress
    for item in reversed(wq.get('queue', [])):
        notes = item.get('notes', '')
        if 's${SESSION_NUM:-0}' in notes or item.get('status') == 'in-progress':
            print(item['id']); break
except: pass
" 2>/dev/null || true)
fi
COMMIT_COUNT=0
if [ -n "${LOG_FILE:-}" ] && [ -f "$LOG_FILE" ]; then
  # Count commits by looking for git commit tool calls in the session log
  COMMIT_COUNT=$(grep -c '"git","commit"' "$LOG_FILE" 2>/dev/null || true)
fi

# === Steps 2-6: Analysis (standalone Python module, extracted R#304) ===
WQ_TASK_ID="$WQ_TASK_ID" COMMIT_COUNT="$COMMIT_COUNT" \
python3 "$DIR/scripts/cost-analysis.py" "$COST_FILE" "$TREND_FILE" "$UTIL_FILE" "$NUDGE_FILE" "$DIRECTIVE_FILE" "${MODE_CHAR:-?}" "${SESSION_NUM:-0}" "$SPENT"

# === Step 7: Cost accuracy dual-record (wq-409) ===
# Records both agent-reported and token-calc costs for every session.
# Passes pre-captured values from step 1 so no file re-reading needed.
DUAL_AGENT_COST="$DUAL_AGENT_COST" DUAL_TOKEN_COST="$DUAL_TOKEN_COST" \
  node "$DIR/cost-accuracy-validator.mjs" --post-hook 2>/dev/null || true
