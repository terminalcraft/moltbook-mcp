#!/bin/bash
# Pre-hook: Generate session warm-start context cache.
# Reads session-history.txt + work-queue.json + engagement-intel.json
# and writes a single session-context.md for the agent to consume.
# Runs for ALL session types. (wq-042, s453)

STATE_DIR="$HOME/.config/moltbook"
MCP_DIR="$HOME/moltbook-mcp"
OUTPUT_FILE="$STATE_DIR/session-context.md"

# wq-705: Replaced python3 with jq+bash for context generation
SESSION_NUM_VAL="${SESSION_NUM:-?}"
MODE_VAL="${MODE_CHAR:-?}"
B_FOCUS_VAL="${B_FOCUS:-}"

{
  echo "# Session $SESSION_NUM_VAL ($MODE_VAL) Context"
  if [ "$MODE_VAL" = "B" ] && [ -n "$B_FOCUS_VAL" ]; then
    echo "B_FOCUS=$B_FOCUS_VAL"
  fi
  echo ""

  # 1. Work queue — top 4 items with status
  WQ_FILE="$MCP_DIR/work-queue.json"
  if [ -f "$WQ_FILE" ]; then
    WQ_ITEMS=$(jq -r '
      [.queue[:4][] |
        (.tags // [] | join(",")) as $tag |
        "- [\(.status)] **\(.id)**: \(.title)" + (if ($tag | length) > 0 then " (\($tag))" else "" end) +
        (if .notes then "\n  > \(.notes[:120])" + (if (.notes | length) > 120 then "..." else "" end) else "" end)
      ] | if length > 0 then "## Work Queue (top items)\n" + join("\n") + "\n" else empty end
    ' "$WQ_FILE" 2>/dev/null)
    [ -n "$WQ_ITEMS" ] && echo -e "$WQ_ITEMS"
  fi

  # 2. Recent session history — last 5 entries
  HIST_FILE="$STATE_DIR/session-history.txt"
  if [ -f "$HIST_FILE" ]; then
    RECENT=$(tail -5 "$HIST_FILE" | grep -v '^$')
    if [ -n "$RECENT" ]; then
      echo "## Recent Sessions"
      echo "$RECENT" | while IFS= read -r line; do
        echo "- $line"
      done
      echo ""
    fi
  fi

  # 3. Engagement intel — last 4 entries (compact)
  INTEL_FILE="$STATE_DIR/engagement-intel.json"
  if [ -f "$INTEL_FILE" ]; then
    INTEL_ITEMS=$(jq -r '
      if length > 0 then
        "## Engagement Intel\n" +
        ([.[-4:][] | "- [\(.type // "?")]  (s\(.session // "?")) \(.summary // "")"] | join("\n")) + "\n"
      else empty end
    ' "$INTEL_FILE" 2>/dev/null)
    [ -n "$INTEL_ITEMS" ] && echo -e "$INTEL_ITEMS"
  fi
} > "$OUTPUT_FILE"

LINE_COUNT=$(wc -l < "$OUTPUT_FILE")
echo "warm-start: wrote $LINE_COUNT lines to session-context.md"
