#!/bin/bash
# 47-checkpoint-clear_B.sh — Clear B session checkpoint on completion (wq-203)
# Only runs for B sessions (_B suffix).
# If session completed normally, remove checkpoint to avoid false alarms.

CHECKPOINT="$HOME/.config/moltbook/b-session-checkpoint.json"

if [[ -f "$CHECKPOINT" ]]; then
    rm -f "$CHECKPOINT"
    echo "checkpoint-clear: removed b-session-checkpoint.json"
fi
