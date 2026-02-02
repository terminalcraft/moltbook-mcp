#!/bin/bash
# Shared hook runner for pre-session and post-session hooks.
# Extracted from heartbeat.sh (R#89) to eliminate duplication between
# the pre-hook runner (no tracking) and post-hook runner (JSON tracking).
#
# Usage: run-hooks.sh <hooks_dir> <timeout_secs> [--track <results_file> <session_num>]
#
# Environment: Passes through all env vars to hooks. Logs to LOG_DIR/hooks.log.
# With --track: writes structured JSON results, keeps last 200 entries.

set -euo pipefail

HOOKS_DIR="${1:?Usage: run-hooks.sh <hooks_dir> <timeout_secs> [--track <results_file> <session_num>]}"
TIMEOUT_SECS="${2:?Missing timeout_secs}"
shift 2

TRACK=""
RESULTS_FILE=""
SESSION_NUM=""
if [ "${1:-}" = "--track" ]; then
  TRACK=1
  RESULTS_FILE="${2:?Missing results_file for --track}"
  SESSION_NUM="${3:?Missing session_num for --track}"
fi

LOG_DIR="${LOG_DIR:-${HOME}/.config/moltbook/logs}"
HOOKS_LOG="$LOG_DIR/hooks.log"

[ -d "$HOOKS_DIR" ] || exit 0

HOOK_PASS=0
HOOK_FAIL=0
HOOK_DETAILS=""

for hook in "$HOOKS_DIR"/*; do
  [ -x "$hook" ] || continue
  HOOK_NAME="$(basename "$hook")"
  HOOK_START=$(date +%s%N)
  echo "$(date -Iseconds) running hook: $HOOK_NAME" >> "$HOOKS_LOG"

  HOOK_EXIT=0
  timeout "$TIMEOUT_SECS" "$hook" >> "$HOOKS_LOG" 2>&1 || HOOK_EXIT=$?

  HOOK_END=$(date +%s%N)
  HOOK_DUR_MS=$(( (HOOK_END - HOOK_START) / 1000000 ))

  if [ "$HOOK_EXIT" -eq 0 ]; then
    HOOK_PASS=$((HOOK_PASS + 1))
    HOOK_STATUS="ok"
  else
    HOOK_FAIL=$((HOOK_FAIL + 1))
    HOOK_STATUS="fail:$HOOK_EXIT"
    echo "$(date -Iseconds) hook FAILED: $HOOK_NAME (exit=$HOOK_EXIT, ${HOOK_DUR_MS}ms)" >> "$HOOKS_LOG"
  fi

  [ -n "$HOOK_DETAILS" ] && HOOK_DETAILS="$HOOK_DETAILS,"
  HOOK_DETAILS="$HOOK_DETAILS{\"hook\":\"$HOOK_NAME\",\"status\":\"$HOOK_STATUS\",\"ms\":$HOOK_DUR_MS}"
done

# Write structured results if tracking enabled
if [ -n "$TRACK" ] && [ -n "$RESULTS_FILE" ]; then
  echo "{\"session\":$SESSION_NUM,\"ts\":\"$(date -Iseconds)\",\"pass\":$HOOK_PASS,\"fail\":$HOOK_FAIL,\"hooks\":[$HOOK_DETAILS]}" >> "$RESULTS_FILE"
  # Keep last 200 entries
  if [ "$(wc -l < "$RESULTS_FILE")" -gt 200 ]; then
    tail -200 "$RESULTS_FILE" > "$RESULTS_FILE.tmp" && mv "$RESULTS_FILE.tmp" "$RESULTS_FILE"
  fi
fi
