#!/bin/bash
# wq-180: Append comprehensive session trace to JSONL for stigmergic learning (d035)
# Creates append-only session-traces.jsonl - never truncated, fully searchable
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
TRACES_FILE="$STATE_DIR/session-traces.jsonl"

# Required env vars
: "${SESSION_NUM:?SESSION_NUM required}"
: "${MODE_CHAR:?MODE_CHAR required}"

# Extract from summary file if available
SUMMARY_FILE="${LOG_FILE%.log}.summary"
if [ ! -f "$SUMMARY_FILE" ]; then
  echo "$(date -Iseconds) s=$SESSION_NUM WARN: no summary file for trace" >> "$STATE_DIR/logs/trace-errors.log"
  exit 0
fi

# Parse summary for core fields
S_DUR=$(grep '^Duration:' "$SUMMARY_FILE" | head -1 | awk '{print $2}' | tr -d '~' || echo "0m0s")
S_BUILD=$(grep '^Build:' "$SUMMARY_FILE" | head -1 | cut -d' ' -f2- || echo "(none)")
S_FILES=$(grep '^Files changed:' "$SUMMARY_FILE" | head -1 | cut -d' ' -f3- || echo "")
S_COST=$(grep '^Cost:' "$SUMMARY_FILE" | head -1 | awk '{print $2}' | tr -d '$' || echo "0")

# Extract commit count
COMMIT_COUNT=0
if [[ "$S_BUILD" =~ ^([0-9]+) ]]; then
  COMMIT_COUNT="${BASH_REMATCH[1]}"
fi

# Convert files to JSON array
FILES_JSON="[]"
if [ -n "$S_FILES" ]; then
  FILES_JSON=$(echo "$S_FILES" | tr ',' '\n' | sed 's/^ */"/;s/ *$/",/' | tr -d '\n' | sed 's/,$//' | sed 's/^/[/;s/$/]/')
fi

# Get assigned task from work-queue if B session
TASK_ID=""
TASK_TITLE=""
if [ "$MODE_CHAR" = "B" ]; then
  TASK_ID=$(jq -r '.queue[] | select(.status == "in-progress" or .status == "pending") | .id' "$DIR/work-queue.json" 2>/dev/null | head -1 || true)
  if [ -n "$TASK_ID" ]; then
    TASK_TITLE=$(jq -r --arg id "$TASK_ID" '.queue[] | select(.id == $id) | .title' "$DIR/work-queue.json" 2>/dev/null || true)
  fi
fi

# Extract E session engagement metrics (wq-386: close trace recording gap)
ENGAGE_JSON="null"
if [ "$MODE_CHAR" = "E" ]; then
  TRACE_FILE="$STATE_DIR/engagement-trace.json"
  INTEL_FILE="$STATE_DIR/engagement-intel.json"
  # Migrated from python3 to jq (wq-728)
  TRACE_PART=$(jq --argjson s "$SESSION_NUM" '
    if type == "array" then [.[] | select(.session == $s)] | first // null
    elif type == "object" and .session == $s then .
    else null end
    | if . != null then {
        platforms: (.platforms_engaged // [] | length),
        threads: (.threads_contributed // [] | length),
        topics: (.topics // [] | length),
        agents: (.agents_interacted // [] | length),
        skipped: (.skipped_platforms // [] | length)
      } else null end
  ' "$TRACE_FILE" 2>/dev/null || echo "null")
  INTEL_COUNT=$(jq 'if type == "array" then length else 0 end' "$INTEL_FILE" 2>/dev/null || echo "0")
  if [ "$TRACE_PART" != "null" ]; then
    ENGAGE_JSON=$(echo "$TRACE_PART" | jq --argjson ic "$INTEL_COUNT" '. + {intel_count: $ic}')
  elif [ "$INTEL_COUNT" -gt 0 ]; then
    ENGAGE_JSON="{\"intel_count\":$INTEL_COUNT}"
  fi
fi

# Get outcome from structured outcomes if available
OUTCOME="unknown"
OUTCOME_FILE="$STATE_DIR/structured-outcomes.json"
if [ -f "$OUTCOME_FILE" ]; then
  OUTCOME=$(jq -r --argjson num "$SESSION_NUM" '.outcomes[] | select(.session == $num) | .outcome' "$OUTCOME_FILE" 2>/dev/null | head -1 || echo "unknown")
fi

# Get debrief summary if available
DECISIONS="[]"
BLOCKERS="[]"
DEBRIEF_FILE="$STATE_DIR/session-debriefs.json"
if [ -f "$DEBRIEF_FILE" ]; then
  DECISIONS=$(jq --argjson num "$SESSION_NUM" '[.[] | select(.session == $num) | .decisions[]] | unique | .[0:3]' "$DEBRIEF_FILE" 2>/dev/null || echo "[]")
  BLOCKERS=$(jq --argjson num "$SESSION_NUM" '[.[] | select(.session == $num) | .blockers[]] | unique | .[0:3]' "$DEBRIEF_FILE" 2>/dev/null || echo "[]")
fi

# Extract note/summary
NOTE=$(awk '
  /^Build:/ { in_build = 1; next }
  /^Feed:/ { in_feed = 1; if (in_build) in_build = 0; next }
  /^[A-Z]/ { in_build = 0; in_feed = 0 }
  in_build && /^ *- / { gsub(/^ *- /, ""); print; exit }
' "$SUMMARY_FILE" || true)

# Build JSON trace entry (single line for JSONL)
TRACE=$(jq -nc \
  --argjson session "$SESSION_NUM" \
  --arg mode "$MODE_CHAR" \
  --arg date "$(date +%Y-%m-%d)" \
  --arg timestamp "$(date -Iseconds)" \
  --arg duration "$S_DUR" \
  --argjson cost "${S_COST:-0}" \
  --argjson commits "$COMMIT_COUNT" \
  --argjson files "$FILES_JSON" \
  --arg task_id "$TASK_ID" \
  --arg task_title "$TASK_TITLE" \
  --arg outcome "$OUTCOME" \
  --argjson decisions "$DECISIONS" \
  --argjson blockers "$BLOCKERS" \
  --arg note "$NOTE" \
  --argjson engage "$ENGAGE_JSON" \
  '{
    session: $session,
    mode: $mode,
    date: $date,
    timestamp: $timestamp,
    duration: $duration,
    cost: $cost,
    commits: $commits,
    files: $files,
    task: (if $task_id != "" then {id: $task_id, title: $task_title} else null end),
    outcome: $outcome,
    debrief: {decisions: $decisions, blockers: $blockers},
    note: $note
  } + (if $engage != null then {engagement: $engage} else {} end)')

# Append to JSONL (atomic append)
echo "$TRACE" >> "$TRACES_FILE"

echo "$(date -Iseconds) s=$SESSION_NUM trace written" >> "$STATE_DIR/logs/trace.log"
