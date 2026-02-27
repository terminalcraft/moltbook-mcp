#!/bin/bash
# Pre-hook: BRIEFING.md auto-staleness detector (wq-011)
# Parses BRIEFING.md into sections by ## headers, checks a state file
# for when each section was last confirmed/updated. Flags sections
# stale for >50 sessions. Outputs warnings that get injected into
# session context.

set -euo pipefail

BRIEFING="$HOME/moltbook-mcp/BRIEFING.md"
STATE_DIR="$HOME/.config/moltbook"
STATE_FILE="$STATE_DIR/briefing-staleness.json"
SESSION_NUM="${SESSION_NUM:-0}"
STALE_THRESHOLD=50

mkdir -p "$STATE_DIR"

# Initialize state if missing
if [ ! -f "$STATE_FILE" ]; then
  echo '{}' > "$STATE_FILE"
fi

# wq-705: Replaced python3 with jq+bash for JSON parsing and content checks

if [ "$SESSION_NUM" -eq 0 ]; then
  exit 0
fi

MCP_DIR="$HOME/moltbook-mcp"

# --- Phase 1: Section-level staleness ---
# Extract ## headers from BRIEFING.md
SECTIONS=$(grep -oP '^## \K.+' "$BRIEFING" | sed 's/[[:space:]]*$//')
SECTION_COUNT=$(echo "$SECTIONS" | grep -c . 2>/dev/null || echo 0)

if [ "$SECTION_COUNT" -eq 0 ]; then
  echo "BRIEFING_STALE: No sections found"
  exit 0
fi

# Build JSON array of section names
SECTIONS_JSON=$(echo "$SECTIONS" | jq -R . | jq -s .)

# Update state: add new sections, remove deleted ones
TMP_STATE=$(mktemp)
jq --argjson session "$SESSION_NUM" --argjson sections "$SECTIONS_JSON" '
  # Add new sections not yet tracked
  reduce $sections[] as $sec (.;
    if has($sec) then . else . + {($sec): {"last_updated": $session}} end
  ) |
  # Remove sections no longer in briefing
  with_entries(select(.key as $k | $sections | index($k)))
' "$STATE_FILE" > "$TMP_STATE" && mv "$TMP_STATE" "$STATE_FILE"

# Check for stale sections
STALE_OUTPUT=$(jq -r --argjson session "$SESSION_NUM" --argjson threshold "$STALE_THRESHOLD" '
  [to_entries[] | select(($session - (.value.last_updated // 0)) >= $threshold) |
    "  - \"\(.key)\" — \($session - (.value.last_updated // 0)) sessions since last update"
  ] |
  if length > 0 then
    "BRIEFING_STALE: \(length) section(s) need review:\n" + join("\n")
  else
    "BRIEFING_STALE: All \(length + (. | length)) sections fresh (threshold: \($threshold))"
  end
' "$STATE_FILE" 2>/dev/null)

# Fix the "all fresh" count — need total sections not stale count
STALE_COUNT=$(jq --argjson session "$SESSION_NUM" --argjson threshold "$STALE_THRESHOLD" \
  '[to_entries[] | select(($session - (.value.last_updated // 0)) >= $threshold)] | length' "$STATE_FILE" 2>/dev/null || echo 0)

if [ "$STALE_COUNT" -gt 0 ]; then
  echo -e "$STALE_OUTPUT"
else
  echo "BRIEFING_STALE: All $SECTION_COUNT sections fresh (threshold: $STALE_THRESHOLD)"
fi

# --- Phase 2: Content-level reference checks ---
WARNINGS=()

# 2a: File path references that don't exist (~/path)
while IFS= read -r ref; do
  [ -z "$ref" ] && continue
  FULL="$HOME/$ref"
  if [ ! -e "$FULL" ]; then
    WARNINGS+=("Missing file: ~/$ref")
  fi
done < <(grep -oP '~/\K[^\s,)]+' "$BRIEFING" 2>/dev/null)

# 2a continued: Bare filenames (*.md, *.json, *.sh, etc.)
SKIP_FILES="agent.json session-history.txt package.json"
while IFS= read -r fname; do
  [ -z "$fname" ] && continue
  echo "$SKIP_FILES" | grep -qw "$fname" && continue
  found=false
  for cand in "$MCP_DIR/$fname" "$HOME/$fname" "$MCP_DIR/hooks/pre-session/$fname" "$MCP_DIR/hooks/post-session/$fname"; do
    [ -e "$cand" ] && found=true && break
  done
  if [ "$found" = false ]; then
    WARNINGS+=("Referenced file not found locally: $fname")
  fi
done < <(grep -oP '\b\w[\w.-]+\.(?:md|json|sh|mjs|js|txt|conf)\b' "$BRIEFING" 2>/dev/null | sort -u)

# 2b: Session references that are very old (>200 sessions ago)
OLD_COUNT=0
OLDEST=999999
while IFS= read -r ref_num; do
  [ -z "$ref_num" ] && continue
  AGE=$((SESSION_NUM - ref_num))
  if [ "$AGE" -gt 200 ]; then
    OLD_COUNT=$((OLD_COUNT + 1))
    [ "$ref_num" -lt "$OLDEST" ] && OLDEST=$ref_num
  fi
done < <(grep -oP '\b[sS]\K\d{3,4}\b' "$BRIEFING" 2>/dev/null | sort -u)

if [ "$OLD_COUNT" -gt 0 ]; then
  WARNINGS+=("$OLD_COUNT old session refs (oldest: s$OLDEST, $((SESSION_NUM - OLDEST)) sessions ago) — consider pruning")
fi

# 2c: "Next X: session NNN" where NNN is in the past
while IFS= read -r target; do
  [ -z "$target" ] && continue
  if [ "$target" -lt "$SESSION_NUM" ]; then
    WARNINGS+=("Overdue scheduled check: 'next ... session $target' (current: $SESSION_NUM)")
  fi
done < <(grep -oiP '[Nn]ext\s+\w+:\s+session\s+\K\d+' "$BRIEFING" 2>/dev/null)

# 2d: Version numbers
while IFS= read -r ver; do
  [ -z "$ver" ] && continue
  WARNINGS+=("Version reference: $ver — verify still current")
done < <(grep -oP 'Version:\s*\K[\d.]+' "$BRIEFING" 2>/dev/null)

if [ "${#WARNINGS[@]}" -gt 0 ]; then
  echo "BRIEFING_REFS: ${#WARNINGS[@]} reference issue(s):"
  for w in "${WARNINGS[@]}"; do
    echo "  - $w"
  done
else
  echo "BRIEFING_REFS: All references valid"
fi
