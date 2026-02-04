#!/bin/bash
# 45-truncation-detect_B.sh — Detect potentially truncated B sessions (wq-192, wq-203)
# Only runs for B sessions (_B suffix). Scans recent history for indicators.
# Also checks for stale checkpoints from session-checkpoint.mjs.
# Surfaces recovery candidates via compliance-nudge.txt if found.

HIST="$HOME/.config/moltbook/session-history.txt"
STATE_DIR="$HOME/.config/moltbook"
OUTPUT="$STATE_DIR/compliance-nudge.txt"
CHECKPOINT="$STATE_DIR/b-session-checkpoint.json"

# Check for stale checkpoint first (wq-203)
if [[ -f "$CHECKPOINT" ]]; then
    CHECKPOINT_AGE=$(python3 -c "
import json, sys
from datetime import datetime
try:
    cp = json.load(open('$CHECKPOINT'))
    ts = datetime.fromisoformat(cp['timestamp'].replace('Z', '+00:00'))
    age = (datetime.now(ts.tzinfo) - ts).total_seconds() / 60
    print(int(age))
except: print(0)
" 2>/dev/null || echo 0)

    # Only alert if checkpoint is 2+ minutes old (session likely truncated)
    if [[ "$CHECKPOINT_AGE" -ge 2 ]]; then
        TASK_ID=$(python3 -c "import json; print(json.load(open('$CHECKPOINT')).get('task_id', 'unknown'))" 2>/dev/null)
        INTENT=$(python3 -c "import json; print(json.load(open('$CHECKPOINT')).get('intent', '')[:60])" 2>/dev/null)
        SESS=$(python3 -c "import json; print(json.load(open('$CHECKPOINT')).get('session', 0))" 2>/dev/null)

        {
            echo ""
            echo "## CHECKPOINT RECOVERY — previous session left breadcrumb"
            echo "s$SESS was working on: $TASK_ID"
            echo "Intent: $INTENT"
            echo "Age: ${CHECKPOINT_AGE}m"
            echo ""
            echo "Run: node session-checkpoint.mjs read  # Full details"
            echo "Run: node session-checkpoint.mjs clear # After recovery"
        } >> "$OUTPUT"

        echo "truncation-detect: found checkpoint from s$SESS ($TASK_ID, ${CHECKPOINT_AGE}m old)"
    fi
fi

[[ ! -f "$HIST" ]] && exit 0

# Indicators of truncation/partial work:
# 1. Very short notes (< 10 chars after "note: ")
# 2. Note ends with incomplete sentence (no punctuation)
# 3. Note contains "partial", "WIP", "truncat", "incomplete"
# 4. Note is just "(commit)" or "(none)"
# 5. Duration shows "~" prefix (approximate, potentially interrupted)

CANDIDATES=()
while IFS= read -r line; do
    # Only check B sessions
    [[ "$line" != *"mode=B"* ]] && continue

    # Extract session number and note
    SESS=$(echo "$line" | grep -oP 's=\K\d+')
    NOTE=$(echo "$line" | grep -oP 'note: \K.*$')
    DUR=$(echo "$line" | grep -oP 'dur=\K[^ ]+')

    # Check indicators
    TRUNCATED=false

    # Very short note
    [[ ${#NOTE} -lt 10 ]] && TRUNCATED=true

    # Note is just "(commit)" or "(none)"
    [[ "$NOTE" == "(commit)" || "$NOTE" == "(none)" ]] && TRUNCATED=true

    # Note contains truncation keywords
    [[ "$NOTE" =~ [Pp]artial|WIP|[Tt]runcat|[Ii]ncomplete ]] && TRUNCATED=true

    # Duration is approximate (starts with ~)
    [[ "$DUR" == ~* ]] && TRUNCATED=true

    # Note ends mid-word or clearly cut off (skip if it looks like a complete commit message)
    # Commit messages like "type(scope): description" are valid even without punctuation
    # Only flag if note seems cut off mid-word or mid-sentence
    if [[ ! "$NOTE" =~ [\.\!\?\)\"]$ ]] && [[ ! "$NOTE" =~ :[[:space:]] ]]; then
        TRUNCATED=true
    fi

    if [[ "$TRUNCATED" == true ]]; then
        CANDIDATES+=("s$SESS: $NOTE")
    fi
done < "$HIST"

# Only show the most recent 3 candidates (older ones are likely resolved)
if [[ ${#CANDIDATES[@]} -gt 0 ]]; then
    RECENT=("${CANDIDATES[@]: -3}")

    {
        echo ""
        echo "## TRUNCATION RECOVERY — potentially incomplete B sessions"
        echo "Recent B sessions with incomplete notes may need follow-up:"
        for c in "${RECENT[@]}"; do
            echo "  - $c"
        done
        echo ""
        echo "Check git log for WIP commits. Resume if work was partial."
    } >> "$OUTPUT"

    echo "truncation-detect: found ${#RECENT[@]} candidate(s) for recovery"
fi
