#!/bin/bash
# 35-r-session-prehook_R.sh — R-session pre-hook dispatcher
#
# Runs r-prehook-runner.mjs which performs all 6 checks in a single
# node process and returns pre-formatted summary text.
#
# Checks performed by runner:
#   1. maintain-audit     — file perms, disk, API, log sizes, directive-audit errors
#   2. security-posture   — gitignore + staged credential checks
#   3. hook-health        — failing/slow hooks from result logs
#   4. directive-analysis — staleness, attention needed
#   5. brainstorm-gate    — ≥3 active ideas check
#   6. issue-summary      — total issues count + ALL CLEAR / TOTAL line
#
# Originally 480→219 lines of bash/jq. Reduced via R#375 (d080 trajectory)
# by moving all formatting into the runner's .summary/.audit_text fields.
#
# Replaces:
#   35-maintain-audit_R.sh    (s383, R#201, R#276)
#   35-security-posture_R.sh  (R#211, d045/d046)
#   36-directive-status_R.sh  (R#185, R#317)
#   44-brainstorm-gate_R.sh   (wq-365)
#
# Created: B#490 (wq-729)
# Expanded: R#330 (d074 Group 2)
# Runner consolidation: B#636 (wq-991, d079)
# Shell simplified: R#375 — runner produces audit_text, shell just echoes

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SESSION="${SESSION_NUM:-1100}"
AUDIT_FILE="$HOME/.config/moltbook/maintain-audit.txt"
STATUS_FILE="$HOME/.config/moltbook/directive-status.txt"

# Run the consolidated node runner (all checks + summary/audit text generation)
RUNNER_OUTPUT=$(node "$DIR/r-prehook-runner.mjs" \
  "$SESSION" "$DIR/directives.json" "$DIR/work-queue.json" \
  "$HOME/.config/moltbook/session-history.txt" 2>/dev/null) || {
  echo "[r-prehook] ERROR: runner failed to execute"
  echo "=== Maintenance audit $(date -Iseconds) s=${SESSION} ===" > "$AUDIT_FILE"
  echo "ERROR: r-prehook-runner.mjs failed" >> "$AUDIT_FILE"
  exit 0
}

# Write audit files from runner output
echo "$RUNNER_OUTPUT" | jq -r '.audit_text // "ERROR: no audit_text in runner output"' > "$AUDIT_FILE"
echo "$RUNNER_OUTPUT" | jq -r '.directive_status_text // "ERROR: no directive_status_text"' > "$STATUS_FILE"

# Extract and display pre-formatted summary
SUMMARY=$(echo "$RUNNER_OUTPUT" | jq -r '.summary // "[r-prehook] ERROR: no summary in runner output"')
echo "$SUMMARY"
