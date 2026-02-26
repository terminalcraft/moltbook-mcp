#!/usr/bin/env bash
# Pre-session hook: inject TODO follow-ups from previous session into prompt
set -euo pipefail
FILE="$HOME/.config/moltbook/todo-followups.txt"
[ -f "$FILE" ] || exit 0
# Only inject for B sessions
[ "${MODE_CHAR:-B}" = "B" ] || { rm -f "$FILE"; exit 0; }
# File exists — it will be consumed by heartbeat.sh injection
# Just leave it for now; cleanup happens after read
