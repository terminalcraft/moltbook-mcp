#!/bin/bash
# Pre-session hook: check retired queue items every 50 sessions
# If a blocker URL now resolves, resurrect the item to pending
# wq-016 brainstorming idea: "Retired item resurrection check"

SESSION_NUM="${SESSION_NUM:-0}"
INTERVAL=50

# Only run every INTERVAL sessions
if (( SESSION_NUM % INTERVAL != 0 )); then
  exit 0
fi

QUEUE_FILE="/home/moltbot/moltbook-mcp/work-queue.json"
CHANGED=0

# Extract retired items and probe URLs in their blockers/retired_reason
while IFS= read -r line; do
  id=$(echo "$line" | jq -r '.id')
  reason=$(echo "$line" | jq -r '.retired_reason // .blocker // ""')

  # Extract URLs from reason text
  urls=$(echo "$reason" | grep -oP 'https?://[^\s),]+' | head -3)
  [ -z "$urls" ] && continue

  resurrected=0
  for url in $urls; do
    # Quick probe — 5s timeout
    status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null)
    if [ "$status" -ge 200 ] && [ "$status" -lt 400 ]; then
      echo "RESURRECT: $id — $url now returns HTTP $status"
      # Update status from retired to pending via jq
      tmp=$(mktemp)
      jq --arg id "$id" --arg session "$SESSION_NUM" '
        .queue |= map(if .id == $id then
          .status = "pending" |
          .resurrected_session = ($session | tonumber) |
          .resurrected_reason = "Blocker URL now reachable"
        else . end)
      ' "$QUEUE_FILE" > "$tmp" && mv "$tmp" "$QUEUE_FILE"
      CHANGED=1
      resurrected=1
      break
    fi
  done

  if [ "$resurrected" -eq 0 ]; then
    echo "STILL BLOCKED: $id"
  fi
done < <(jq -c '.queue[] | select(.status == "retired")' "$QUEUE_FILE")

if [ "$CHANGED" -eq 1 ]; then
  echo "Queue updated — resurrected items moved to pending"
fi
