#!/bin/bash
# 35-briefing-directive-check_A.sh — Detect stale directive references in BRIEFING.md
# Created: B#547 (wq-863)
#
# Cross-references directive IDs (d0XX) in BRIEFING.md against their actual status
# in directives.json. If BRIEFING.md references a directive as if active/relevant
# but it's already completed in directives.json, flags it as a critical audit finding.
#
# Context: d072 was stale in BRIEFING.md for 8 sessions before A#198 caught it manually.
# This automates that detection.
#
# Non-blocking: findings are reported but don't prevent session start.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
OUTPUT_FILE="$STATE_DIR/briefing-directive-audit.json"
BRIEFING="$DIR/BRIEFING.md"
DIRECTIVES_FILE="$DIR/directives.json"

# Validate input files
if [ ! -f "$BRIEFING" ] || [ ! -f "$DIRECTIVES_FILE" ]; then
  echo '{"checked":"'"$(date -Iseconds)"'","session":'"${SESSION_NUM:-0}"',"stale_count":0,"stale_refs":[],"error":"missing BRIEFING.md or directives.json"}' > "$OUTPUT_FILE"
  echo "[briefing-directives] ERROR: missing input files"
  exit 0
fi

# Extract all d0XX references from BRIEFING.md with their line context
# Then cross-reference against directives.json status
RESULT=$(jq -n \
  --argjson session "${SESSION_NUM:-0}" \
  --arg checked "$(date -Iseconds)" \
  --arg briefing_content "$(cat "$BRIEFING")" \
  --slurpfile directives "$DIRECTIVES_FILE" \
  '
  # Build lookup: directive_id -> status
  ($directives[0].directives | map({(.id): .status}) | add // {}) as $status_map |

  # Build lookup: directive_id -> completed_session
  ($directives[0].directives | map({(.id): (.completed_session // null)}) | add // {}) as $completed_map |

  # Extract d0XX references from BRIEFING content with context
  # Filter: only flag completed directives that are NOT already described as completed
  # in the BRIEFING line. This avoids false positives for historical references like
  # "d070 (reduce system complexity) completed s1669".
  [
    $briefing_content | split("\n") | to_entries[] |
    .key as $line_num |
    .value as $line |
    ($line | ascii_downcase) as $line_lower |
    # Find d0XX patterns in this line
    [$line | match("d(0[0-9]{2})"; "g") | "d" + .captures[0].string] |
    select(length > 0) |
    .[] |
    . as $dir_id |
    select($status_map[$dir_id] == "completed") |
    # Skip if the line already describes this directive as completed/done/closed
    select(
      ($line_lower | test("completed|done|closed|finished|retired|past deadline")) | not
    ) |
    # Also skip parenthetical attributions like "(d042)" or "(ROI-weighted, d042)"
    # These are origin references, not active status claims
    select(
      ($line | test("\\([^)]*" + $dir_id + "[^(]*\\)")) | not
    ) |
    {
      directive: $dir_id,
      status: "completed",
      completed_session: $completed_map[$dir_id],
      briefing_line: ($line_num + 1),
      context: ($line | ltrimstr(" ") | if length > 120 then .[:120] + "..." else . end)
    }
  ] |

  # Deduplicate by directive ID (keep first occurrence)
  group_by(.directive) | map(.[0]) |

  . as $stale_refs |
  {
    checked: $checked,
    session: $session,
    stale_count: ($stale_refs | length),
    stale_refs: $stale_refs,
    severity: (if ($stale_refs | length) > 0 then "critical" else "clean" end)
  }
') || {
  echo '{"checked":"'"$(date -Iseconds)"'","session":'"${SESSION_NUM:-0}"',"stale_count":0,"stale_refs":[],"error":"jq processing failed"}' > "$OUTPUT_FILE"
  echo "[briefing-directives] ERROR: jq processing failed"
  exit 0
}

echo "$RESULT" > "$OUTPUT_FILE"

STALE_COUNT=$(echo "$RESULT" | jq '.stale_count')

if [ "$STALE_COUNT" -gt 0 ]; then
  DETAILS=$(echo "$RESULT" | jq -r '[.stale_refs[] | "\(.directive)(completed s\(.completed_session // "?"))"] | join(", ")')
  echo "[briefing-directives] CRITICAL: $STALE_COUNT directive(s) referenced in BRIEFING.md but completed in directives.json: $DETAILS"
else
  echo "[briefing-directives] OK: no stale directive references in BRIEFING.md"
fi

exit 0
