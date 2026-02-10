#!/bin/bash
# Test suite for cache-wrapper.sh
# Run: bash hooks/lib/cache-wrapper.test.sh

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Setup
export SESSION_NUM=100
source "$SCRIPT_DIR/cache-wrapper.sh"

# Use temp dir for test isolation
TEST_CACHE_DIR=$(mktemp -d)
HOOK_CACHE_DIR="$TEST_CACHE_DIR"
mkdir -p "$HOOK_CACHE_DIR"

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

echo "=== cache-wrapper.sh tests ==="

# Test 1: Cache miss — command executes
echo "Test 1: Cache miss executes command"
output=$(cache_run "test-key-1" 60 echo "hello from command")
if echo "$output" | grep -q "hello from command"; then
  echo "  PASS: command output present"
  ((PASS++))
else
  echo "  FAIL: command output missing"
  ((FAIL++))
fi
if echo "$output" | grep -q "Cache miss"; then
  echo "  PASS: cache miss message shown"
  ((PASS++))
else
  echo "  FAIL: cache miss message missing"
  ((FAIL++))
fi

# Test 2: Cache hit — command does not re-execute
echo "Test 2: Cache hit returns cached result"
output=$(cache_run "test-key-1" 60 echo "should not see this")
if echo "$output" | grep -q "Using cached result"; then
  echo "  PASS: cache hit detected"
  ((PASS++))
else
  echo "  FAIL: expected cache hit"
  ((FAIL++))
fi
if echo "$output" | grep -q "hello from command"; then
  echo "  PASS: cached output replayed"
  ((PASS++))
else
  echo "  FAIL: cached output not replayed"
  ((FAIL++))
fi

# Test 3: Cache file structure
echo "Test 3: Cache file is valid JSON"
if jq -e '.timestamp' "$HOOK_CACHE_DIR/test-key-1.json" >/dev/null 2>&1; then
  echo "  PASS: cache file has timestamp"
  ((PASS++))
else
  echo "  FAIL: cache file missing timestamp"
  ((FAIL++))
fi
session_val=$(jq -r '.session' "$HOOK_CACHE_DIR/test-key-1.json")
assert_eq "session recorded" "100" "$session_val"

# Test 4: cache_invalidate
echo "Test 4: cache_invalidate removes cache"
cache_invalidate "test-key-1"
if [ ! -f "$HOOK_CACHE_DIR/test-key-1.json" ]; then
  echo "  PASS: cache file removed"
  ((PASS++))
else
  echo "  FAIL: cache file still exists"
  ((FAIL++))
fi

# Test 5: cache_status on missing key
echo "Test 5: cache_status on missing key"
output=$(cache_status "nonexistent" 2>&1)
status=$?
assert_eq "returns 1 for missing" "1" "$status"

# Test 6: Exit code preservation
echo "Test 6: Exit code preserved through cache"
cache_run "test-fail" 60 bash -c "echo 'failing'; exit 42" || true
cached_exit=$(jq -r '.exit_code' "$HOOK_CACHE_DIR/test-fail.json")
assert_eq "exit code 42 cached" "42" "$cached_exit"

# Test 7: TTL expiry (use 0-minute TTL)
echo "Test 7: Zero TTL forces re-execution"
cache_run "test-ttl" 60 echo "first run"
sleep 1
output=$(cache_run "test-ttl" 0 echo "second run")
if echo "$output" | grep -q "second run"; then
  echo "  PASS: zero TTL caused re-execution"
  ((PASS++))
else
  echo "  FAIL: zero TTL should have re-executed"
  ((FAIL++))
fi

# Test 8: Multiline output preserved
echo "Test 8: Multiline output preserved"
cache_run "test-multi" 60 bash -c 'echo "line1"; echo "line2"; echo "line3"'
cache_invalidate "test-multi"  # force re-read from fresh
cache_run "test-multi" 60 bash -c 'echo "line1"; echo "line2"; echo "line3"'
output=$(cache_run "test-multi" 60 echo "should be cached")
line_count=$(echo "$output" | grep -c "line[0-9]" || echo 0)
if [ "$line_count" -ge 3 ]; then
  echo "  PASS: multiline output preserved ($line_count lines)"
  ((PASS++))
else
  echo "  FAIL: multiline output lost (got $line_count lines)"
  ((FAIL++))
fi

# Cleanup
rm -rf "$TEST_CACHE_DIR"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
