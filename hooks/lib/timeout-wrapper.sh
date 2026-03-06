#!/bin/bash
# hooks/lib/timeout-wrapper.sh — Standard timeout+watchdog behavior for hooks.
# wq-872: Extracts the repeated pattern from 02-periodic-checks.sh and 09-financial-check.sh
# into a reusable library any hook can source.
#
# Usage:
#   source "$(dirname "$0")/../lib/timeout-wrapper.sh"  # or however you reach lib/
#
#   # Configure (optional — defaults shown):
#   HOOK_TIMEOUT=10       # Overall hook watchdog (seconds)
#   CHECK_TIMEOUT=5       # Default per-check timeout (seconds)
#   TIMING_FILE=""        # JSONL telemetry file (empty = no logging)
#
#   # Run checks in parallel:
#   tw_run "check-name" my_command arg1 arg2
#   tw_run "other-check" --timeout 15 node expensive.mjs   # per-check override
#
#   # Or run a bash function (avoids 'bash -c ...' quoting for multi-line logic):
#   my_check() { curl -s http://example.com/health | jq .status; }
#   tw_run_fn "my-check" my_check
#
#   # Wait for all + watchdog:
#   tw_wait   # returns 0 if all checks finished before watchdog, 1 if watchdog fired
#
# Each tw_run spawns a background subshell with `timeout $CHECK_TIMEOUT`.
# tw_wait starts a watchdog that kills all remaining children after HOOK_TIMEOUT,
# then waits for completion. Timing telemetry is written if TIMING_FILE is set.

# Defaults (hooks can override before calling tw_run)
: "${HOOK_TIMEOUT:=10}"
: "${CHECK_TIMEOUT:=5}"
: "${TIMING_FILE:=}"
: "${SESSION_NUM:=0}"

# Internal state
_TW_PIDS=()
_TW_NAMES=()
_TW_HOOK_START=""
_TW_PID_FILE=""

# tw_run <name> [--timeout N] <command...>
# Spawn a check as a background job with per-check timeout.
# Exit code 124 from `timeout` indicates the check was killed.
tw_run() {
  local name="$1"
  shift

  local check_timeout="$CHECK_TIMEOUT"
  if [ "$1" = "--timeout" ]; then
    check_timeout="$2"
    shift 2
  fi

  # Record hook start time on first call
  if [ -z "$_TW_HOOK_START" ]; then
    _TW_HOOK_START=$(date +%s%N)
  fi

  (
    local _start_ns
    _start_ns=$(date +%s%N)
    timeout "$check_timeout" "$@"
    local ec=$?
    _tw_log_timing "$name" "$_start_ns" "$ec"
    exit $ec
  ) &

  _TW_PIDS+=($!)
  _TW_NAMES+=("$name")
}

# tw_run_fn <name> [--timeout N] <function_name> [args...]
# Like tw_run, but dispatches a bash function (avoids 'bash -c ...' quoting).
# The function must be defined in the calling script before tw_run_fn is called.
tw_run_fn() {
  local name="$1"
  shift

  local check_timeout="$CHECK_TIMEOUT"
  if [ "$1" = "--timeout" ]; then
    check_timeout="$2"
    shift 2
  fi

  local fn_name="$1"
  shift

  # Record hook start time on first call
  if [ -z "$_TW_HOOK_START" ]; then
    _TW_HOOK_START=$(date +%s%N)
  fi

  (
    local _start_ns
    _start_ns=$(date +%s%N)
    timeout "$check_timeout" bash -c "$(declare -f "$fn_name"); $fn_name $*"
    local ec=$?
    _tw_log_timing "$name" "$_start_ns" "$ec"
    exit $ec
  ) &

  _TW_PIDS+=($!)
  _TW_NAMES+=("$name")
}

# tw_wait
# Start watchdog, wait for all checks, clean up.
# Returns 0 if all checks completed before watchdog, 1 if watchdog fired.
tw_wait() {
  if [ ${#_TW_PIDS[@]} -eq 0 ]; then
    return 0
  fi

  # Write PIDs to temp file for watchdog subshell
  _TW_PID_FILE=$(mktemp)
  printf '%s\n' "${_TW_PIDS[@]}" > "$_TW_PID_FILE"

  local watchdog_fired=0
  local watchdog_sentinel
  watchdog_sentinel=$(mktemp)
  rm -f "$watchdog_sentinel"  # sentinel exists only if watchdog fires

  # Watchdog: kill all children after HOOK_TIMEOUT
  (
    sleep "$HOOK_TIMEOUT"
    touch "$watchdog_sentinel"
    while IFS= read -r pid; do
      kill "$pid" 2>/dev/null
    done < "$_TW_PID_FILE"
    rm -f "$_TW_PID_FILE"
  ) &
  local watchdog_pid=$!

  # Wait for all checks (or watchdog kills them)
  wait "${_TW_PIDS[@]}" 2>/dev/null

  # Cancel watchdog
  kill "$watchdog_pid" 2>/dev/null
  wait "$watchdog_pid" 2>/dev/null

  # Detect if watchdog fired via sentinel file
  if [ -f "$watchdog_sentinel" ]; then
    watchdog_fired=1
  fi
  rm -f "$watchdog_sentinel" "$_TW_PID_FILE" 2>/dev/null

  # Log overall hook timing
  if [ -n "$TIMING_FILE" ] && [ -n "$_TW_HOOK_START" ]; then
    local hook_end hook_ms names_json
    hook_end=$(date +%s%N)
    hook_ms=$(( (hook_end - _TW_HOOK_START) / 1000000 ))
    names_json=$(printf '"%s",' "${_TW_NAMES[@]}" | sed 's/,$//')
    echo "{\"ts\":\"$(date -Iseconds)\",\"session\":$SESSION_NUM,\"check\":\"_total\",\"ms\":$hook_ms,\"watchdog\":$watchdog_fired,\"checks\":[$names_json]}" >> "$TIMING_FILE"
  fi

  # Reset state for potential reuse
  _TW_PIDS=()
  _TW_NAMES=()
  _TW_HOOK_START=""

  return $watchdog_fired
}

# _tw_log_timing <name> <start_ns> <exit_code>
# Internal: write per-check timing to TIMING_FILE (if set).
_tw_log_timing() {
  [ -z "$TIMING_FILE" ] && return 0
  local name="$1" start_ns="$2" exit_code="$3"
  local end_ns elapsed_ms timed_out
  end_ns=$(date +%s%N)
  elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))
  timed_out="false"
  [ "$exit_code" -eq 124 ] && timed_out="true"
  echo "{\"ts\":\"$(date -Iseconds)\",\"session\":$SESSION_NUM,\"check\":\"$name\",\"ms\":$elapsed_ms,\"exit\":$exit_code,\"timeout\":$timed_out}" >> "$TIMING_FILE"
}
