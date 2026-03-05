#!/bin/bash
# Test suite for timeout-wrapper.sh
# Run: bash hooks/lib/timeout-wrapper.test.sh

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $desc"
    ((PASS++))
  else
    echo "  FAIL: $desc (expected '$expected', got '$actual')"
    ((FAIL++))
  fi
}

echo "=== timeout-wrapper.sh tests ==="

# Source the library
export SESSION_NUM=100
export HOOK_TIMEOUT=5
export CHECK_TIMEOUT=3
export TIMING_FILE=""
source "$SCRIPT_DIR/timeout-wrapper.sh"

# ─── Test 1: Basic parallel execution ───
echo "Test 1: Two checks run in parallel and complete"
TMPFILE1=$(mktemp)
TMPFILE2=$(mktemp)

tw_run "check-a" bash -c "echo 'a-done' > $TMPFILE1"
tw_run "check-b" bash -c "echo 'b-done' > $TMPFILE2"
tw_wait
wc=$?

assert_eq "tw_wait returns 0 (no watchdog)" "0" "$wc"
assert_eq "check-a completed" "a-done" "$(cat "$TMPFILE1" 2>/dev/null)"
assert_eq "check-b completed" "b-done" "$(cat "$TMPFILE2" 2>/dev/null)"
rm -f "$TMPFILE1" "$TMPFILE2"

# ─── Test 2: Per-check timeout kills slow check ───
echo "Test 2: Per-check timeout kills slow command"
CHECK_TIMEOUT=1
HOOK_TIMEOUT=5
SLOW_MARKER=$(mktemp)
rm -f "$SLOW_MARKER"

tw_run "slow-check" bash -c "sleep 10; echo done > $SLOW_MARKER"
tw_wait
wc=$?

assert_eq "tw_wait returns 0 (watchdog did not fire)" "0" "$wc"
if [ ! -f "$SLOW_MARKER" ]; then
  echo "  PASS: slow check was killed before completing"
  ((PASS++))
else
  echo "  FAIL: slow check completed (should have been killed)"
  ((FAIL++))
fi
rm -f "$SLOW_MARKER"

# ─── Test 3: --timeout override ───
echo "Test 3: Per-check --timeout override"
CHECK_TIMEOUT=1
HOOK_TIMEOUT=5
OVERRIDE_MARKER=$(mktemp)
rm -f "$OVERRIDE_MARKER"

tw_run "custom-timeout" --timeout 3 bash -c "sleep 2; echo done > $OVERRIDE_MARKER"
tw_wait

assert_eq "custom timeout check completed" "done" "$(cat "$OVERRIDE_MARKER" 2>/dev/null)"
rm -f "$OVERRIDE_MARKER"

# ─── Test 4: Hook-level watchdog fires ───
echo "Test 4: Hook watchdog kills remaining checks"
CHECK_TIMEOUT=30
HOOK_TIMEOUT=2
WATCHDOG_MARKER=$(mktemp)
rm -f "$WATCHDOG_MARKER"

tw_run "stuck-check" bash -c "sleep 30; echo done > $WATCHDOG_MARKER"
tw_wait
wc=$?

assert_eq "tw_wait returns 1 (watchdog fired)" "1" "$wc"
if [ ! -f "$WATCHDOG_MARKER" ]; then
  echo "  PASS: stuck check killed by watchdog"
  ((PASS++))
else
  echo "  FAIL: stuck check completed despite watchdog"
  ((FAIL++))
fi
rm -f "$WATCHDOG_MARKER"

# ─── Test 5: Timing telemetry written ───
echo "Test 5: Timing telemetry"
TIMING_DIR=$(mktemp -d)
TIMING_FILE="$TIMING_DIR/timing.jsonl"
CHECK_TIMEOUT=3
HOOK_TIMEOUT=5

tw_run "timed-check" bash -c "sleep 0.1; true"
tw_wait

if [ -f "$TIMING_FILE" ]; then
  LINE_COUNT=$(wc -l < "$TIMING_FILE")
  if [ "$LINE_COUNT" -ge 2 ]; then
    echo "  PASS: timing file has per-check + total entries ($LINE_COUNT lines)"
    ((PASS++))
  else
    echo "  FAIL: expected >=2 lines, got $LINE_COUNT"
    ((FAIL++))
  fi
  # Validate JSON (each line individually for JSONL)
  ALL_VALID=true
  while IFS= read -r line; do
    if ! echo "$line" | jq -e '.check' >/dev/null 2>&1; then
      ALL_VALID=false
    fi
  done < "$TIMING_FILE"
  if $ALL_VALID; then
    echo "  PASS: timing entries are valid JSON"
    ((PASS++))
  else
    echo "  FAIL: timing entries are not valid JSON"
    ((FAIL++))
  fi
  # Check per-check entry (JSONL — grep for check name)
  if grep -q '"timed-check"' "$TIMING_FILE"; then
    echo "  PASS: per-check entry found"
    ((PASS++))
  else
    echo "  FAIL: per-check entry missing"
    ((FAIL++))
  fi
  # Check total entry
  if grep -q '"_total"' "$TIMING_FILE"; then
    echo "  PASS: total entry found"
    ((PASS++))
  else
    echo "  FAIL: total entry missing"
    ((FAIL++))
  fi
else
  echo "  FAIL: timing file not created"
  ((FAIL++)); ((FAIL++)); ((FAIL++)); ((FAIL++))
fi
rm -rf "$TIMING_DIR"
TIMING_FILE=""

# ─── Test 6: Empty tw_wait (no checks) ───
echo "Test 6: tw_wait with no checks returns 0"
tw_wait
wc=$?
assert_eq "empty tw_wait returns 0" "0" "$wc"

# ─── Test 7: State resets between tw_wait calls ───
echo "Test 7: State resets between calls"
CHECK_TIMEOUT=3
HOOK_TIMEOUT=5
RESET_MARKER=$(mktemp)
RESET_MARKER2=$(mktemp)

tw_run "first-batch" bash -c "echo batch1 > $RESET_MARKER"
tw_wait

tw_run "second-batch" bash -c "echo batch2 > $RESET_MARKER2"
tw_wait
wc=$?

assert_eq "second batch completed" "batch2" "$(cat "$RESET_MARKER2" 2>/dev/null)"
assert_eq "second tw_wait returns 0" "0" "$wc"
rm -f "$RESET_MARKER" "$RESET_MARKER2"

# ─── Results ───
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
