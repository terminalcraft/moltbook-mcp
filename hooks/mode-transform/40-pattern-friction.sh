#!/bin/bash
# Mode transform: B→R when pattern analysis shows high friction signals
# Hot files touched repeatedly without stabilization (tests, refactoring) need R attention.
# Input: MODE_CHAR
# Output: "NEW_MODE reason" or empty string

[ "$MODE_CHAR" = "B" ] || exit 0

# Fetch /status/patterns and check friction_signal count
PATTERNS=$(curl -s --max-time 3 http://localhost:3847/status/patterns 2>/dev/null)
[ -z "$PATTERNS" ] && exit 0

# Extract friction signal count from hot_files.friction_signal
FRICTION_COUNT=$(echo "$PATTERNS" | jq -r '.patterns.hot_files.friction_signal // 0')

# Threshold: 8+ files with friction means significant stabilization debt
if [ "$FRICTION_COUNT" -ge 8 ]; then
  echo "R high friction ($FRICTION_COUNT files need stabilization)"
fi
