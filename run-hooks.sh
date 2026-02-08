#!/bin/bash
# Shared hook runner for pre-session and post-session hooks.
# Extracted from heartbeat.sh (R#89) to eliminate duplication between
# the pre-hook runner (no tracking) and post-hook runner (JSON tracking).
#
# Usage: run-hooks.sh <hooks_dir> <timeout_secs> [--track <results_file> <session_num>] [--budget <total_secs>]
#
# Environment: Passes through all env vars to hooks. Logs to LOG_DIR/hooks.log.
# With --track: writes structured JSON results, keeps last 200 entries.
# With --budget: enforces aggregate time limit across all hooks. Once cumulative
#   execution time exceeds the budget, remaining hooks are skipped (status: budget_skip).
#   This prevents slow hooks from eating session budget. (R#205)
#
# Timeout penalty (R#205): Hooks that timed out (exit 124) in the previous session
# get their per-hook timeout halved, providing back-pressure on chronically slow hooks.
#
# Session-type scoping (R#101): Hooks can declare session type affinity via
# filename suffix. Suffix _B.sh runs only in B sessions, _E.sh only in E, etc.
# Hooks without session suffix run unconditionally. This replaces the pattern
# of each hook checking MODE_CHAR and exiting early.

set -euo pipefail

HOOKS_DIR="${1:?Usage: run-hooks.sh <hooks_dir> <timeout_secs> [--track <results_file> <session_num>] [--budget <total_secs>] [--parallel <max_jobs>]}"
TIMEOUT_SECS="${2:?Missing timeout_secs}"
shift 2

TRACK=""
RESULTS_FILE=""
SESSION_NUM=""
BUDGET_SECS=0
PARALLEL_JOBS=0

# Parse remaining args
while [ $# -gt 0 ]; do
  case "${1:-}" in
    --track)
      TRACK=1
      RESULTS_FILE="${2:?Missing results_file for --track}"
      SESSION_NUM="${3:?Missing session_num for --track}"
      shift 3
      ;;
    --budget)
      BUDGET_SECS="${2:?Missing total_secs for --budget}"
      shift 2
      ;;
    --parallel)
      PARALLEL_JOBS="${2:?Missing max_jobs for --parallel}"
      shift 2
      ;;
    *) shift ;;
  esac
done

LOG_DIR="${LOG_DIR:-${HOME}/.config/moltbook/logs}"
HOOKS_LOG="$LOG_DIR/hooks.log"
CURRENT_MODE="${MODE_CHAR:-}"

[ -d "$HOOKS_DIR" ] || exit 0

# Load adaptive timeout profiles (wq-427: hook-timing-tuner)
# Per-hook recommended timeouts based on historical P95 latencies
declare -A TUNED_TIMEOUTS
PROFILES_PATH="${HOME}/.config/moltbook/hook-timing-profiles.json"
HOOKS_DIR_BASE=$(basename "$HOOKS_DIR")
if [ -f "$PROFILES_PATH" ]; then
  PROFILE_SECTION="pre_session"
  [[ "$HOOKS_DIR_BASE" == "post-session" ]] && PROFILE_SECTION="post_session"
  while IFS='=' read -r hook_name rec_timeout; do
    [ -n "$hook_name" ] && TUNED_TIMEOUTS["$hook_name"]="$rec_timeout"
  done < <(python3 -c "
import sys,json
try:
    d = json.load(open('$PROFILES_PATH'))
    for name, p in d.get('$PROFILE_SECTION', {}).get('profiles', {}).items():
        print(f\"{name}={p['recommended_timeout_secs']}\")
except: pass" 2>/dev/null)
fi

# Build set of hooks that timed out in previous session (R#205: timeout penalty)
# Hooks that previously timed out get halved per-hook timeout
declare -A PREV_TIMEOUTS
if [ -n "$TRACK" ] && [ -n "$RESULTS_FILE" ] && [ -f "$RESULTS_FILE" ]; then
  LAST_LINE=$(tail -1 "$RESULTS_FILE" 2>/dev/null || echo "")
  if [ -n "$LAST_LINE" ]; then
    # Extract hook names with fail:124 status (timeout) from JSON
    while IFS= read -r hook_name; do
      [ -n "$hook_name" ] && PREV_TIMEOUTS["$hook_name"]=1
    done < <(echo "$LAST_LINE" | python3 -c "
import sys,json
try:
    d = json.loads(sys.stdin.read().strip())
    for h in d.get('hooks', []):
        if h.get('status') == 'fail:124':
            print(h['hook'])
except: pass" 2>/dev/null)
  fi
fi

HOOK_PASS=0
HOOK_FAIL=0
HOOK_SKIP=0
HOOK_BUDGET_SKIP=0
HOOK_DETAILS=""
CUMULATIVE_MS=0

# run_single_hook: execute one hook, classify result, append to HOOKS_LOG
# Sets: HOOK_STATUS, HOOK_DUR_MS, HOOK_ERROR, FAILURE_CAT (via output file protocol)
# Args: $1=hook_path $2=result_file (writes JSON fragment per hook)
run_single_hook() {
  local hook="$1" result_file="$2"
  local hook_name
  hook_name="$(basename "$hook")"

  # Timeout selection: adaptive profile (wq-427) > penalty (R#205) > default
  local eff_timeout="$TIMEOUT_SECS"
  if [ -n "${TUNED_TIMEOUTS[$hook_name]+x}" ]; then
    eff_timeout="${TUNED_TIMEOUTS[$hook_name]}"
  fi
  if [ -n "${PREV_TIMEOUTS[$hook_name]+x}" ]; then
    eff_timeout=$(( eff_timeout / 2 ))
    [ "$eff_timeout" -lt 5 ] && eff_timeout=5
    echo "$(date -Iseconds) hook PENALTY: $hook_name timeout ${TIMEOUT_SECS}s→${eff_timeout}s (timed out last session)" >> "$HOOKS_LOG"
  fi

  local hook_start hook_end hook_dur_ms hook_exit hook_out hook_status hook_error failure_cat
  hook_start=$(date +%s%N)
  echo "$(date -Iseconds) running hook: $hook_name" >> "$HOOKS_LOG"

  hook_out=$(mktemp)
  hook_exit=0
  timeout "$eff_timeout" "$hook" > "$hook_out" 2>&1 || hook_exit=$?
  cat "$hook_out" >> "$HOOKS_LOG"

  hook_end=$(date +%s%N)
  hook_dur_ms=$(( (hook_end - hook_start) / 1000000 ))

  hook_error=""
  failure_cat=""
  if [ "$hook_exit" -eq 0 ]; then
    hook_status="ok"
  else
    hook_status="fail:$hook_exit"
    echo "$(date -Iseconds) hook FAILED: $hook_name (exit=$hook_exit, ${hook_dur_ms}ms)" >> "$HOOKS_LOG"
    hook_error=$(tail -3 "$hook_out" | tr '\n' ' ' | head -c 200 | sed 's/["\]/\\&/g; s/[[:cntrl:]]/ /g')

    local hook_raw_err
    hook_raw_err=$(cat "$hook_out" 2>/dev/null || true)
    if [ "$hook_exit" -eq 124 ]; then
      failure_cat="timeout"
    elif [ "$hook_exit" -eq 127 ]; then
      failure_cat="command_not_found"
    elif [ "$hook_exit" -eq 126 ]; then
      failure_cat="permission_denied"
    elif echo "$hook_raw_err" | grep -qiE 'Cannot find module|MODULE_NOT_FOUND'; then
      failure_cat="module_not_found"
    elif echo "$hook_raw_err" | grep -qiE 'SyntaxError|syntax error'; then
      failure_cat="syntax_error"
    elif echo "$hook_raw_err" | grep -qiE 'No such file or directory|ENOENT'; then
      failure_cat="missing_file"
    elif echo "$hook_raw_err" | grep -qiE 'Permission denied|EACCES'; then
      failure_cat="permission_denied"
    elif echo "$hook_raw_err" | grep -qiE 'ReferenceError|TypeError|RangeError|Error:.*\bat\b'; then
      failure_cat="node_crash"
    elif echo "$hook_raw_err" | grep -qiE 'ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH'; then
      failure_cat="network_error"
    elif echo "$hook_raw_err" | grep -qiE 'invalid.*config|missing.*config|bad.*config'; then
      failure_cat="config_error"
    else
      failure_cat="unknown"
    fi
  fi
  rm -f "$hook_out"

  # Write result as a single JSON line to result_file
  if [ -n "$hook_error" ]; then
    echo "{\"hook\":\"$hook_name\",\"status\":\"$hook_status\",\"ms\":$hook_dur_ms,\"error\":\"$hook_error\",\"failure_category\":\"$failure_cat\"}" >> "$result_file"
  else
    echo "{\"hook\":\"$hook_name\",\"status\":\"$hook_status\",\"ms\":$hook_dur_ms}" >> "$result_file"
  fi
}

# Collect eligible hooks (after session-type filtering)
ELIGIBLE_HOOKS=()
for hook in "$HOOKS_DIR"/*; do
  [ -x "$hook" ] || continue
  HOOK_NAME="$(basename "$hook")"

  case "$HOOK_NAME" in
    *_B.sh) [ "$CURRENT_MODE" = "B" ] || { HOOK_SKIP=$((HOOK_SKIP + 1)); continue; } ;;
    *_E.sh) [ "$CURRENT_MODE" = "E" ] || { HOOK_SKIP=$((HOOK_SKIP + 1)); continue; } ;;
    *_R.sh) [ "$CURRENT_MODE" = "R" ] || { HOOK_SKIP=$((HOOK_SKIP + 1)); continue; } ;;
    *_A.sh) [ "$CURRENT_MODE" = "A" ] || { HOOK_SKIP=$((HOOK_SKIP + 1)); continue; } ;;
  esac

  ELIGIBLE_HOOKS+=("$hook")
done

# Parallel execution mode (R#217): run hooks concurrently in batches
# Sequential mode preserved as default for backward compatibility
if [ "$PARALLEL_JOBS" -gt 1 ] && [ "${#ELIGIBLE_HOOKS[@]}" -gt 1 ]; then
  RESULTS_TMP=$(mktemp)
  RUNNING_PIDS=()
  RUNNING_HOOKS=()
  BATCH_START=$(date +%s%N)

  for hook in "${ELIGIBLE_HOOKS[@]}"; do
    HOOK_NAME="$(basename "$hook")"

    # Budget enforcement: check before launching new hooks
    if [ "$BUDGET_SECS" -gt 0 ] && [ "$CUMULATIVE_MS" -gt $((BUDGET_SECS * 1000)) ]; then
      HOOK_BUDGET_SKIP=$((HOOK_BUDGET_SKIP + 1))
      echo "{\"hook\":\"$HOOK_NAME\",\"status\":\"budget_skip\",\"ms\":0}" >> "$RESULTS_TMP"
      echo "$(date -Iseconds) hook BUDGET_SKIP: $HOOK_NAME (cumulative ${CUMULATIVE_MS}ms > budget ${BUDGET_SECS}s)" >> "$HOOKS_LOG"
      continue
    fi

    # Launch hook in background
    run_single_hook "$hook" "$RESULTS_TMP" &
    RUNNING_PIDS+=($!)
    RUNNING_HOOKS+=("$HOOK_NAME")

    # Throttle: when batch is full, wait for all to finish before next batch
    if [ "${#RUNNING_PIDS[@]}" -ge "$PARALLEL_JOBS" ]; then
      for pid in "${RUNNING_PIDS[@]}"; do
        wait "$pid" 2>/dev/null || true
      done
      # Update cumulative time from batch wall-clock
      BATCH_END=$(date +%s%N)
      BATCH_DUR_MS=$(( (BATCH_END - BATCH_START) / 1000000 ))
      CUMULATIVE_MS=$((CUMULATIVE_MS + BATCH_DUR_MS))
      RUNNING_PIDS=()
      RUNNING_HOOKS=()
      BATCH_START=$(date +%s%N)
    fi
  done

  # Wait for final partial batch
  if [ "${#RUNNING_PIDS[@]}" -gt 0 ]; then
    for pid in "${RUNNING_PIDS[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
    BATCH_END=$(date +%s%N)
    BATCH_DUR_MS=$(( (BATCH_END - BATCH_START) / 1000000 ))
    CUMULATIVE_MS=$((CUMULATIVE_MS + BATCH_DUR_MS))
  fi

  # Collect results from temp file into HOOK_DETAILS and counters
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    [ -n "$HOOK_DETAILS" ] && HOOK_DETAILS="$HOOK_DETAILS,"
    HOOK_DETAILS="$HOOK_DETAILS$line"

    # Parse status for counters
    local_status=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read().strip()).get('status',''))" 2>/dev/null || echo "")
    case "$local_status" in
      ok) HOOK_PASS=$((HOOK_PASS + 1)) ;;
      budget_skip) ;; # already counted
      *) HOOK_FAIL=$((HOOK_FAIL + 1)) ;;
    esac
  done < "$RESULTS_TMP"
  rm -f "$RESULTS_TMP"

else
  # Sequential execution (original behavior, default)
  for hook in "${ELIGIBLE_HOOKS[@]}"; do
    HOOK_NAME="$(basename "$hook")"

    # Aggregate budget enforcement (R#205)
    if [ "$BUDGET_SECS" -gt 0 ] && [ "$CUMULATIVE_MS" -gt $((BUDGET_SECS * 1000)) ]; then
      HOOK_BUDGET_SKIP=$((HOOK_BUDGET_SKIP + 1))
      [ -n "$HOOK_DETAILS" ] && HOOK_DETAILS="$HOOK_DETAILS,"
      HOOK_DETAILS="$HOOK_DETAILS{\"hook\":\"$HOOK_NAME\",\"status\":\"budget_skip\",\"ms\":0}"
      echo "$(date -Iseconds) hook BUDGET_SKIP: $HOOK_NAME (cumulative ${CUMULATIVE_MS}ms > budget ${BUDGET_SECS}s)" >> "$HOOKS_LOG"
      continue
    fi

    # Timeout selection: adaptive profile (wq-427) > penalty (R#205) > default
    EFFECTIVE_TIMEOUT="$TIMEOUT_SECS"
    if [ -n "${TUNED_TIMEOUTS[$HOOK_NAME]+x}" ]; then
      EFFECTIVE_TIMEOUT="${TUNED_TIMEOUTS[$HOOK_NAME]}"
    fi
    if [ -n "${PREV_TIMEOUTS[$HOOK_NAME]+x}" ]; then
      EFFECTIVE_TIMEOUT=$(( EFFECTIVE_TIMEOUT / 2 ))
      [ "$EFFECTIVE_TIMEOUT" -lt 5 ] && EFFECTIVE_TIMEOUT=5
      echo "$(date -Iseconds) hook PENALTY: $HOOK_NAME timeout ${TIMEOUT_SECS}s→${EFFECTIVE_TIMEOUT}s (timed out last session)" >> "$HOOKS_LOG"
    fi

    HOOK_START=$(date +%s%N)
    echo "$(date -Iseconds) running hook: $HOOK_NAME" >> "$HOOKS_LOG"

    HOOK_OUT=$(mktemp)
    HOOK_EXIT=0
    timeout "$EFFECTIVE_TIMEOUT" "$hook" > "$HOOK_OUT" 2>&1 || HOOK_EXIT=$?
    cat "$HOOK_OUT" >> "$HOOKS_LOG"

    HOOK_END=$(date +%s%N)
    HOOK_DUR_MS=$(( (HOOK_END - HOOK_START) / 1000000 ))
    CUMULATIVE_MS=$((CUMULATIVE_MS + HOOK_DUR_MS))

    HOOK_ERROR=""
    if [ "$HOOK_EXIT" -eq 0 ]; then
      HOOK_PASS=$((HOOK_PASS + 1))
      HOOK_STATUS="ok"
    else
      HOOK_FAIL=$((HOOK_FAIL + 1))
      HOOK_STATUS="fail:$HOOK_EXIT"
      echo "$(date -Iseconds) hook FAILED: $HOOK_NAME (exit=$HOOK_EXIT, ${HOOK_DUR_MS}ms)" >> "$HOOKS_LOG"
      HOOK_ERROR=$(tail -3 "$HOOK_OUT" | tr '\n' ' ' | head -c 200 | sed 's/["\]/\\&/g; s/[[:cntrl:]]/ /g')

      HOOK_RAW_ERR=$(cat "$HOOK_OUT" 2>/dev/null || true)
      if [ "$HOOK_EXIT" -eq 124 ]; then
        FAILURE_CAT="timeout"
      elif [ "$HOOK_EXIT" -eq 127 ]; then
        FAILURE_CAT="command_not_found"
      elif [ "$HOOK_EXIT" -eq 126 ]; then
        FAILURE_CAT="permission_denied"
      elif echo "$HOOK_RAW_ERR" | grep -qiE 'Cannot find module|MODULE_NOT_FOUND'; then
        FAILURE_CAT="module_not_found"
      elif echo "$HOOK_RAW_ERR" | grep -qiE 'SyntaxError|syntax error'; then
        FAILURE_CAT="syntax_error"
      elif echo "$HOOK_RAW_ERR" | grep -qiE 'No such file or directory|ENOENT'; then
        FAILURE_CAT="missing_file"
      elif echo "$HOOK_RAW_ERR" | grep -qiE 'Permission denied|EACCES'; then
        FAILURE_CAT="permission_denied"
      elif echo "$HOOK_RAW_ERR" | grep -qiE 'ReferenceError|TypeError|RangeError|Error:.*\bat\b'; then
        FAILURE_CAT="node_crash"
      elif echo "$HOOK_RAW_ERR" | grep -qiE 'ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH'; then
        FAILURE_CAT="network_error"
      elif echo "$HOOK_RAW_ERR" | grep -qiE 'invalid.*config|missing.*config|bad.*config'; then
        FAILURE_CAT="config_error"
      else
        FAILURE_CAT="unknown"
      fi
    fi
    rm -f "$HOOK_OUT"

    [ -n "$HOOK_DETAILS" ] && HOOK_DETAILS="$HOOK_DETAILS,"
    if [ -n "$HOOK_ERROR" ]; then
      HOOK_DETAILS="$HOOK_DETAILS{\"hook\":\"$HOOK_NAME\",\"status\":\"$HOOK_STATUS\",\"ms\":$HOOK_DUR_MS,\"error\":\"$HOOK_ERROR\",\"failure_category\":\"$FAILURE_CAT\"}"
    else
      HOOK_DETAILS="$HOOK_DETAILS{\"hook\":\"$HOOK_NAME\",\"status\":\"$HOOK_STATUS\",\"ms\":$HOOK_DUR_MS}"
    fi
  done
fi

# Write structured results if tracking enabled
if [ -n "$TRACK" ] && [ -n "$RESULTS_FILE" ]; then
  echo "{\"session\":$SESSION_NUM,\"ts\":\"$(date -Iseconds)\",\"pass\":$HOOK_PASS,\"fail\":$HOOK_FAIL,\"skip\":$HOOK_SKIP,\"budget_skip\":$HOOK_BUDGET_SKIP,\"total_ms\":$CUMULATIVE_MS,\"hooks\":[$HOOK_DETAILS]}" >> "$RESULTS_FILE"
  # Keep last 200 entries
  if [ "$(wc -l < "$RESULTS_FILE")" -gt 200 ]; then
    tail -200 "$RESULTS_FILE" > "$RESULTS_FILE.tmp" && mv "$RESULTS_FILE.tmp" "$RESULTS_FILE"
  fi
fi
