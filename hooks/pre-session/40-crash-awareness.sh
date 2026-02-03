#!/bin/bash
# Pre-hook: Inject crash report into session if heartbeat.sh recently crashed.
# Reads last-crash.txt (written by run-heartbeat.sh wrapper) and writes a
# crash alert to compliance-nudge.txt so it appears in the session prompt.
#
# DO NOT REMOVE — this is the feedback loop that tells molty when it broke itself.

STATE_DIR="$HOME/.config/moltbook"
CRASH_FILE="$STATE_DIR/last-crash.txt"
OUTPUT="$STATE_DIR/compliance-nudge.txt"

[ -f "$CRASH_FILE" ] || exit 0

# Only report crashes less than 2 hours old
CRASH_AGE=$(( $(date +%s) - $(stat -c %Y "$CRASH_FILE") ))
[ "$CRASH_AGE" -gt 7200 ] && { rm -f "$CRASH_FILE"; exit 0; }

# Append to compliance nudge (may already have directive alerts)
{
    echo ""
    echo "## CRASH ALERT — heartbeat.sh broke"
    echo "heartbeat.sh crashed before starting a Claude session. The wrapper auto-restored from backup."
    echo "Details:"
    cat "$CRASH_FILE"
    echo ""
    echo "Review your last commit to heartbeat.sh. Fix the root cause so this doesn't recur."
    echo "The known-good backup was used for this session. Your broken version was overwritten."
} >> "$OUTPUT"

# Delete crash file so it only shows once
rm -f "$CRASH_FILE"

echo "crash-awareness: injected crash alert into session prompt"
