#!/bin/bash
# 35-a-session-prehook_A.sh — A-session pre-hook dispatcher
#
# Runs a-prehook-runner.mjs which performs all 8 checks in a single
# node process and returns pre-formatted summary text.
#
# Checks performed by runner:
#   1. Cost trend monitor (B + R sessions)
#   2. Stale reference detection (calls stale-ref-check.sh)
#   3. Hook timing report
#   4. Stale tag detection + remediation
#   5. Credential health cleanup
#   6. BRIEFING.md directive staleness
#   7. Cost escalation
#   8. Auto-retire stuck queue items
#   9. Dead platform DNS prune (every 50 sessions)
#
# Originally 480 lines of bash/jq. Reduced via d080 (wq-1011) by moving
# all formatting into the runner's .summary field.
#
# Replaces:
#   28-cost-trend-monitor_A.sh  (B#483, wq-727)
#   29-stale-ref-check_A.sh     (B#390, wq-508)
#   32-hook-timing-check_A.sh   (B#528, wq-827)
#   33-stale-tag-check_A.sh     (B#529, wq-828)
#   34-cred-health-cleanup_A.sh (B#543, wq-850)
#   35-briefing-directive-check_A.sh (B#547, wq-863)
#   37-cost-escalation_A.sh     (B#565, wq-888)
#
# Created: R#329 (d074 Group 1)
# Optimized: B#624 (wq-971) — single node runner replaces 5 subprocesses
# Refactored: wq-1011 (d080) — runner produces summary text, shell just echoes

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SESSION="${SESSION_NUM:-0}"

# Run the consolidated node runner (all checks + summary text generation)
RUNNER_OUTPUT=$(node "$DIR/a-prehook-runner.mjs" --session "$SESSION" --apply-stale-tags 2>/dev/null) || {
  echo "[a-prehook] ERROR: runner failed to execute"
  exit 0
}

# Extract and display pre-formatted summary
SUMMARY=$(echo "$RUNNER_OUTPUT" | jq -r '.summary // "[a-prehook] ERROR: no summary in runner output"')
echo "$SUMMARY"
