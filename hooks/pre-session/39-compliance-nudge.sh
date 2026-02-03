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

export TRACKING_FILE="$TRACKING"
export OUTPUT_FILE="$OUTPUT"

python3 << 'PYEOF'
import json, os

mode = os.environ.get("MODE_CHAR", "")
tracking_file = os.environ.get("TRACKING_FILE", "")
output_file = os.environ.get("OUTPUT_FILE", "")

if not mode or not tracking_file or not output_file:
    exit(0)

MODE_MAP = {
    "structural-change": ["R"], "commit-and-push": ["B", "R"],
    "reflection-summary": ["R"], "platform-engagement": ["E"],
    "platform-discovery": ["E"], "queue-consumption": ["B"],
    "ecosystem-adoption": ["B", "E", "R"], "briefing-update": ["R"],
    "directive-update": ["R"]
}

with open(tracking_file) as f:
    data = json.load(f)

nudges = []
for did, info in data.get("compliance", {}).get("metrics", {}).items():
    if mode not in MODE_MAP.get(did, []):
        continue

    history = info.get("history", [])
    if len(history) < 3:
        continue

    recent = history[-5:]
    ignored_count = sum(1 for h in recent if h.get("result") == "ignored")

    if ignored_count >= 3:
        total_f = info.get("followed", 0)
        total_i = info.get("ignored", 0)
        total = total_f + total_i
        rate = int(100 * total_f / total) if total > 0 else 0
        reason = info.get("last_ignored_reason", "")
        streak = 0
        for h in reversed(recent):
            if h.get("result") == "ignored":
                streak += 1
            else:
                break

        nudge = "- " + did + ": " + str(ignored_count) + "/5 recent sessions ignored (" + str(rate) + "% lifetime). "
        if streak >= 3:
            nudge += str(streak) + "-session ignore streak. "
        if reason:
            nudge += "Last reason: " + reason[:120]
        nudges.append(nudge)

if nudges:
    with open(output_file, "w") as f:
        f.write("## Compliance alerts (from directives.json)\n")
        f.write("These directives are being consistently missed in your session type:\n")
        for n in nudges:
            f.write(n + "\n")
        f.write("\nAddress at least one this session, or explain in your summary why you cannot.\n")
    print("compliance-nudge: " + str(len(nudges)) + " alerts for mode " + mode)
else:
    print("compliance-nudge: all clear for mode " + mode)
PYEOF
