#!/bin/bash
# 31-hr-schema-check_A.sh — Validate human-review.json for duplicate keys and schema issues
# Created: B#516 (wq-796)
#
# Motivation: hr-a173-1 had a duplicate 'updated' key that went undetected for
# multiple audit cycles because JSON.parse silently takes the last value.
# This hook catches duplicate keys and schema violations before the A session starts.
#
# Non-blocking: issues are reported but don't prevent session start.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"

output=$(node "$DIR/validate-human-review.mjs" 2>&1) || {
  echo "$output"
  exit 0
}

echo "$output"
exit 0
