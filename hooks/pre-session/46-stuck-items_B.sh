#!/bin/bash
# 46-stuck-items_B.sh — Detect work-queue items stuck in-progress (wq-197)
# Only runs for B sessions (_B suffix). Flags items in-progress for 5+ sessions.
# Writes to compliance-nudge.txt so it surfaces in session prompt.

STATE_DIR="$HOME/.config/moltbook"
WORK_QUEUE="$HOME/moltbook-mcp/work-queue.json"
HIST="$STATE_DIR/session-history.txt"
OUTPUT="$STATE_DIR/compliance-nudge.txt"

[[ ! -f "$WORK_QUEUE" ]] && exit 0
[[ ! -f "$HIST" ]] && exit 0

# Get current session number from most recent history entry
CURRENT_SESSION=$(tail -1 "$HIST" | grep -oP 's=\K\d+' || echo 0)
[[ "$CURRENT_SESSION" -eq 0 ]] && exit 0

# Count B sessions in history (for reference)
B_SESSION_COUNT=$(grep -c "mode=B" "$HIST" || echo 0)

# Parse in-progress items with notes that mention session numbers
# Look for pattern like "B#NNN" or "s=NNN" in notes to determine when work started
STUCK_ITEMS=()

while IFS= read -r line; do
    # Extract item ID
    ID=$(echo "$line" | jq -r '.id // empty' 2>/dev/null)
    [[ -z "$ID" ]] && continue

    TITLE=$(echo "$line" | jq -r '.title // empty' 2>/dev/null)
    NOTES=$(echo "$line" | jq -r '.notes // empty' 2>/dev/null)
    STARTED=$(echo "$line" | jq -r '.started // empty' 2>/dev/null)
    CREATED_SESSION=$(echo "$line" | jq -r '.created_session // 0' 2>/dev/null)

    # Try to determine when item became in-progress
    # Priority: created_session > sNNN in notes (global session refs)
    # Note: B#NNN patterns are B-session-relative counters, not global session numbers
    START_SESSION=0

    # Prefer created_session field (authoritative global session number)
    [[ "$CREATED_SESSION" -gt 0 ]] && START_SESSION=$CREATED_SESSION

    # Fall back to sNNN pattern in notes (global session references)
    if [[ "$START_SESSION" -eq 0 && -n "$NOTES" ]]; then
        S_REF=$(echo "$NOTES" | grep -oP '\bs\K\d{3,}' | head -1)
        [[ -n "$S_REF" ]] && START_SESSION=$S_REF
    fi

    # Can't determine start, skip
    [[ "$START_SESSION" -eq 0 ]] && continue

    # Count B sessions since start
    # Simple heuristic: in BBBRE rotation, ~60% of sessions are B
    SESSIONS_ELAPSED=$((CURRENT_SESSION - START_SESSION))
    B_SESSIONS_APPROX=$((SESSIONS_ELAPSED * 60 / 100))

    if [[ "$B_SESSIONS_APPROX" -ge 5 ]]; then
        STUCK_ITEMS+=("$ID: $TITLE (started ~s$START_SESSION, ~$B_SESSIONS_APPROX B sessions)")
    fi
done < <(jq -c '.queue[] | select(.status == "in-progress")' "$WORK_QUEUE" 2>/dev/null)

if [[ ${#STUCK_ITEMS[@]} -gt 0 ]]; then
    {
        echo ""
        echo "## STUCK ITEMS — in-progress for 5+ B sessions"
        echo "These work-queue items may need attention or closure:"
        for item in "${STUCK_ITEMS[@]}"; do
            echo "  - $item"
        done
        echo ""
        echo "Either complete, block (with blocker reason), or retire if no longer relevant."
    } >> "$OUTPUT"

    echo "stuck-items: found ${#STUCK_ITEMS[@]} potentially stuck item(s)"
fi
