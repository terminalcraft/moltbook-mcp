#!/bin/bash
# 35-e-session-prehook_E.sh — E-session pre-hook dispatcher
#
# Runs e-prehook-runner.mjs which performs all checks (2-9 + picker) in a
# single node process and returns pre-formatted summary text.
# Liveness probe stays separate (uses process.exit() for hard timeout).
#
# Originally 337 lines of bash/jq. Reduced via d080 (wq-1016) by moving
# all formatting + context-file appending into the runner's .summary field.
#
# Replaces:
#   35-engagement-liveness_E.sh (wq-197, R#271, R#275)
#   36-engagement-seed_E.sh     (wq-031, s437)
#   36-topic-clusters_E.sh      (wq-595)
#   37-conversation-balance_E.sh (d041) — merged B#497 (wq-754)
#   38-spending-policy_E.sh      (d059, R#223) — merged B#497 (wq-754)
#
# Created: B#490 (wq-729), expanded B#497 (wq-754)
# Optimized: B#631 (wq-983) — single node runner replaces 10 subprocesses
# Refactored: wq-1016 (d080) — runner produces summary text, shell just echoes

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SESSION="${SESSION_NUM:-0}"
STATE_DIR="$HOME/.config/moltbook"
CACHE_FILE="$STATE_DIR/liveness-cache.json"
CACHE_MAX_AGE=7200

###############################################################################
# Check 1: Engagement platform liveness (separate process — uses process.exit)
###############################################################################
check_engagement_liveness() {
  cache_fresh=false
  if [ -f "$CACHE_FILE" ]; then
    cache_mtime=$(stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0)
    now=$(date +%s)
    cache_age=$(( now - cache_mtime ))
    if [ "$cache_age" -lt "$CACHE_MAX_AGE" ]; then
      cache_fresh=true
    fi
  fi

  if [ "$cache_fresh" = true ]; then
    echo "[liveness] Cache fresh (${cache_age}s old), skipping live probe."
    if [ -f "$DIR/platform-circuits.json" ]; then
      open_count=$(jq '[to_entries[] | select(.value | type == "object" and .status == "open")] | length' "$DIR/platform-circuits.json" 2>/dev/null || echo "?")
      echo "[liveness] Open circuits: $open_count (from cached probe)"
    fi
    echo "[liveness] Done."
    return 0
  fi

  echo "[liveness] Cache stale (${cache_age:-missing}s), probing live..."
  output=$(timeout 3 node "$DIR/engagement-liveness-probe.mjs" --session "$SESSION" 2>&1)
  exit_code=$?
  echo "$output"

  if [ $exit_code -eq 124 ]; then
    echo "[liveness] WARNING: Probe exceeded 3s hard limit, killed. Using cached circuit state."
  elif [ $exit_code -ne 0 ]; then
    echo "[liveness] WARNING: Probe failed (exit $exit_code), continuing with cached circuit state"
  fi

  echo "[liveness] Done."
}

###############################################################################
# Run: liveness in background, then consolidated runner for everything else
###############################################################################

# Phase 1: Liveness probe (separate process, background)
check_engagement_liveness &
pid_liveness=$!

# Phase 2: Consolidated runner (all checks + summary text generation)
RUNNER_OUTPUT=$(timeout 12 node "$DIR/e-prehook-runner.mjs" \
  --context-file "$STATE_DIR/e-session-context.md" \
  --policy-file "$STATE_DIR/spending-policy.json" \
  --session "$SESSION" 2>/dev/null) || {
  echo "[e-runner] ERROR: runner failed to execute"
  wait $pid_liveness
  exit 0
}

# Wait for liveness probe
wait $pid_liveness

# Extract and display pre-formatted summary
SUMMARY=$(echo "$RUNNER_OUTPUT" | jq -r '.summary // "[e-prehook] ERROR: no summary in runner output"')
echo "$SUMMARY"
