#!/bin/bash
# Pre-hook: Read directives.json compliance history and generate a compliance nudge
# for the current session mode. Writes to ~/.config/moltbook/compliance-nudge.txt
# which heartbeat.sh injects into the prompt.
#
# This closes the feedback loop: post-session audit → tracking data → pre-session nudge.
# Without this, compliance data was write-only data that nobody acted on.

set -euo pipefail

STATE_DIR="$HOME/.config/moltbook"
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TRACKING="$DIR/directives.json"
OUTPUT="$STATE_DIR/compliance-nudge.txt"
MODE="${MODE_CHAR:-}"

# Clear previous nudge
rm -f "$OUTPUT"

[ -f "$TRACKING" ] || exit 0
[ -n "$MODE" ] || exit 0

# wq-705: Replaced python3 with jq for compliance nudge generation
# MODE_MAP encoded in jq — maps metric names to applicable session types
NUDGE_OUTPUT=$(jq -r --arg mode "$MODE" '
  # Mode map: which metrics apply to which session types
  {
    "structural-change": ["R"],
    "commit-and-push": ["B", "R"],
    "reflection-summary": ["R"],
    "platform-engagement": ["E"],
    "platform-discovery": ["E"],
    "queue-consumption": ["B"],
    "ecosystem-adoption": ["B", "E", "R"],
    "briefing-update": ["R"],
    "directive-update": ["R"]
  } as $mode_map |

  [
    .compliance.metrics // {} | to_entries[] |
    select(($mode_map[.key] // []) | index($mode)) |
    .key as $did | .value as $info |

    select(($info.history // []) | length >= 3) |
    ($info.history // [] | .[-5:]) as $recent |
    ([$recent[] | select(.result == "ignored")] | length) as $ignored_count |

    select($ignored_count >= 3) |

    ($info.followed // 0) as $total_f |
    ($info.ignored // 0) as $total_i |
    ($total_f + $total_i) as $total |
    (if $total > 0 then ($total_f * 100 / $total | floor) else 0 end) as $rate |
    ($info.last_ignored_reason // "") as $reason |

    # Calculate ignore streak from end
    (reduce ($recent | reverse | .[]) as $h (0;
      if . >= 0 and $h.result == "ignored" then . + 1 else -1 end
    ) | if . < 0 then (. * -1) - 1 else . end) as $streak |

    "- \($did): \($ignored_count)/5 recent sessions ignored (\($rate)% lifetime). " +
    (if $streak >= 3 then "\($streak)-session ignore streak. " else "" end) +
    (if ($reason | length) > 0 then "Last reason: \($reason[:120])" else "" end)
  ] |

  if length > 0 then
    . as $nudges |
    "## Compliance alerts (from directives.json)\nThese directives are being consistently missed in your session type:\n" +
    ($nudges | join("\n")) +
    "\n\nAddress at least one this session, or explain in your summary why you cannot."
  else empty end
' "$TRACKING" 2>/dev/null)

if [ -n "$NUDGE_OUTPUT" ]; then
  echo "$NUDGE_OUTPUT" > "$OUTPUT"
  NUDGE_COUNT=$(echo "$NUDGE_OUTPUT" | grep -c '^- ' || echo 0)
  echo "compliance-nudge: $NUDGE_COUNT alerts for mode $MODE"
else
  echo "compliance-nudge: all clear for mode $MODE"
fi
