#!/bin/bash
# Pre-hook: Generate E session context seed from engagement-intel.json + recent E session history.
# Output: ~/.config/moltbook/e-session-context.md (consumed by heartbeat.sh for E sessions only)
# Only runs for E sessions (enforced by _E.sh filename suffix since R#101). (wq-031, s437)

STATE_DIR="$HOME/.config/moltbook"
INTEL_FILE="$STATE_DIR/engagement-intel.json"
HISTORY_FILE="$STATE_DIR/session-history.txt"
OUTPUT_FILE="$STATE_DIR/e-session-context.md"

# wq-705: Replaced python3 with bash+jq for context generation
HAS_CONTENT=false

{
  # 1. Recent E session summaries from session-history.txt
  if [ -f "$HISTORY_FILE" ]; then
    E_SESSIONS=$(grep 'mode=E' "$HISTORY_FILE" | tail -3)
    if [ -n "$E_SESSIONS" ]; then
      echo "## Last E sessions"
      echo "$E_SESSIONS" | while IFS= read -r line; do echo "- $line"; done
      echo ""
      HAS_CONTENT=true
    fi
  fi

  # 2. Engagement intel entries
  if [ -f "$INTEL_FILE" ]; then
    INTEL_OUT=$(jq -r '
      if length > 0 then
        "## Engagement intel (from recent sessions)\n" +
        ([.[-8:][] |
          "- **[\(.type // "?")]** (s\(.session // "?")) \(.summary // "")" +
          (if .actionable then "\n  - Action: \(.actionable)" else "" end)
        ] | join("\n")) + "\n"
      else empty end
    ' "$INTEL_FILE" 2>/dev/null)
    if [ -n "$INTEL_OUT" ]; then
      echo -e "$INTEL_OUT"
      HAS_CONTENT=true
    fi
  fi

  # 3. Extract platforms covered in last E session to help rotation
  if [ -f "$HISTORY_FILE" ]; then
    LAST_E=$(grep 'mode=E' "$HISTORY_FILE" | tail -1)
    if [ -n "$LAST_E" ]; then
      NOTE=$(echo "$LAST_E" | sed -n 's/.*note: //p')
      if [ -n "$NOTE" ]; then
        echo "## Platform rotation hint"
        echo "Last E session covered: $NOTE"
        echo "Prioritize platforms NOT mentioned above."
        echo ""
        HAS_CONTENT=true
      fi
    fi
  fi

  # 4. Budget utilization warning from recent E sessions
  if [ -f "$HISTORY_FILE" ]; then
    COSTS=$(grep 'mode=E' "$HISTORY_FILE" | tail -5 | grep -oP 'cost=\$\K[\d.]+')
    if [ -n "$COSTS" ]; then
      COUNT=$(echo "$COSTS" | wc -l)
      SUM=$(echo "$COSTS" | awk '{s+=$1} END {printf "%.2f", s}')
      AVG=$(echo "$SUM $COUNT" | awk '{printf "%.2f", $1/$2}')
      echo "## Budget utilization alert"
      if [ "$(echo "$AVG" | awk '{print ($1 < 1.50)}')" = "1" ]; then
        echo "WARNING: Last $COUNT E sessions averaged \$$AVG (target: \$1.50+)."
        echo "You MUST use the Phase 4 budget gate. Do NOT end the session until you have spent at least \$1.50."
        echo "After each platform engagement, check your budget spent from the system-reminder line."
        echo "If under \$1.50, loop back to Phase 2 with another platform."
      else
        echo "Recent E sessions averaging \$$AVG — on target."
      fi
      echo ""
      HAS_CONTENT=true
    fi
  fi

  # 5. d049 violation nudge (wq-375 mechanical enforcement)
  NUDGE_FILE="$STATE_DIR/d049-nudge.txt"
  if [ -f "$NUDGE_FILE" ]; then
    NUDGE=$(cat "$NUDGE_FILE")
    if [ -n "$NUDGE" ]; then
      echo "$NUDGE"
      echo ""
      HAS_CONTENT=true
    fi
  fi
} > "$OUTPUT_FILE"

LINE_COUNT=$(wc -l < "$OUTPUT_FILE")
if [ "$LINE_COUNT" -gt 0 ]; then
  echo "wrote $LINE_COUNT lines to e-session-context.md"
else
  rm -f "$OUTPUT_FILE"
  echo "no engagement context to seed"
fi
