#!/bin/bash
# 35-r-session-prehook_R.sh — Consolidated R-session pre-hook dispatcher
#
# Merges 4 individual R-session pre-hooks into a single dispatcher.
# All checks write to maintain-audit.txt for R session visibility.
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

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
AUDIT_FILE="$HOME/.config/moltbook/maintain-audit.txt"
SESSION_NUM="${SESSION_NUM:-1100}"

ISSUES=0

###############################################################################
# Pre-compute: Run r-prehook-runner.mjs once for all Node/jq checks
###############################################################################
RUNNER_JSON=$(node "$DIR/r-prehook-runner.mjs" \
  "$SESSION_NUM" "$DIR/directives.json" "$DIR/work-queue.json" \
  "$HOME/.config/moltbook/session-history.txt" 2>/dev/null || echo '{}')

###############################################################################
# Check 1: Maintenance audit (was 35-maintain-audit_R.sh)
#   Security, disk, API, logs, hooks health checks
###############################################################################
check_maintain_audit() {
  echo "=== Maintenance audit $(date -Iseconds) s=${SESSION_NUM:-?} ===" > "$AUDIT_FILE"

  # 1. Security: check sensitive file permissions
  for f in "$DIR/wallet.json" "$DIR/ctxly.json" "$DIR/.env" "$HOME/.config/moltbook/engagement-state.json"; do
    [ -f "$f" ] || continue
    PERMS=$(stat -c%a "$f" 2>/dev/null || echo "???")
    if [ "$PERMS" != "600" ]; then
      echo "WARN: $f has permissions $PERMS (expected 600)" >> "$AUDIT_FILE"
      ISSUES=$((ISSUES + 1))
    fi
  done

  # 2. Disk usage
  DISK_PCT=$(df /home/moltbot --output=pcent | tail -1 | tr -d ' %')
  if [ "$DISK_PCT" -gt 80 ]; then
    echo "WARN: Disk usage at ${DISK_PCT}%" >> "$AUDIT_FILE"
    ISSUES=$((ISSUES + 1))
  fi

  # 3. API health
  if ! curl -sf http://localhost:3847/health > /dev/null 2>&1; then
    echo "WARN: API not responding on localhost:3847" >> "$AUDIT_FILE"
    ISSUES=$((ISSUES + 1))
  fi

  # 4. Log sizes
  for logfile in "$HOME/.config/moltbook/logs"/*.log; do
    [ -f "$logfile" ] || continue
    SIZE=$(stat -c%s "$logfile" 2>/dev/null || echo 0)
    if [ "$SIZE" -gt 5242880 ]; then
      echo "WARN: $(basename "$logfile") is $(( SIZE / 1048576 ))MB" >> "$AUDIT_FILE"
      ISSUES=$((ISSUES + 1))
    fi
  done

  # 5. Directive audit log errors
  AUDIT_LOG="$HOME/.config/moltbook/logs/directive-audit.log"
  if [ -f "$AUDIT_LOG" ]; then
    RECENT_ERRORS=$(tail -5 "$AUDIT_LOG" | grep -c "ERROR" || true)
    if [ "$RECENT_ERRORS" -gt 0 ]; then
      echo "WARN: $RECENT_ERRORS recent directive-audit errors — check directive-audit.log" >> "$AUDIT_FILE"
      ISSUES=$((ISSUES + 1))
    fi
  fi

  # 6. Hook health: surface consistently failing or slow hooks
  # Uses pre-computed runner output (r-prehook-runner.mjs) instead of jq subprocess
  HOOK_WARNINGS=$(echo "$RUNNER_JSON" | jq -r '.hook_health.warnings[]? // empty' 2>/dev/null || true)
  if [ -n "$HOOK_WARNINGS" ]; then
    echo "$HOOK_WARNINGS" >> "$AUDIT_FILE"
    HOOK_ISSUES=$(echo "$HOOK_WARNINGS" | grep -c "WARN:" || echo 0)
    ISSUES=$((ISSUES + HOOK_ISSUES))
  fi
}

###############################################################################
# Check 2: Security posture (was 35-security-posture_R.sh)
#   Git credential exposure checks
###############################################################################
check_security_posture() {
  cd "$DIR"

  SEC_ISSUES=0

  # Check known sensitive files are gitignored
  for f in agentid.json account-registry.json *-credentials.json *.key wallet.json ctxly.json identity-keys.json; do
    if ! git check-ignore -q "$f" 2>/dev/null; then
      echo "SEC_WARN: $f not gitignored" >> "$AUDIT_FILE"
      SEC_ISSUES=$((SEC_ISSUES + 1))
    fi
  done

  # Check for credential-pattern files that might be staged
  STAGED=$(git status --porcelain 2>/dev/null | grep -E '(credentials|wallet|agentid|registry|identity|ctxly|\.key|\.pem|\.env)' || true)
  if [ -n "$STAGED" ]; then
    echo "SEC_CRITICAL: Credential files in git working tree:" >> "$AUDIT_FILE"
    echo "$STAGED" >> "$AUDIT_FILE"
    SEC_ISSUES=$((SEC_ISSUES + 1))
  fi

  ISSUES=$((ISSUES + SEC_ISSUES))

  if [ "$SEC_ISSUES" -eq 0 ]; then
    echo "Security posture: CLEAN" >> "$AUDIT_FILE"
  else
    echo "Security posture: $SEC_ISSUES issue(s) — R session MUST address before committing" >> "$AUDIT_FILE"
  fi

  echo "Security posture: $SEC_ISSUES issue(s)"
}

###############################################################################
# Check 3: Directive status (was 36-directive-status_R.sh)
#   Pre-computes which directives need attention in step 5
###############################################################################
check_directive_status() {
  local STATUS_FILE="$HOME/.config/moltbook/directive-status.txt"
  local DIRECTIVES_FILE="$DIR/directives.json"
  local QUEUE_FILE="$DIR/work-queue.json"
  local HISTORY_FILE="$HOME/.config/moltbook/session-history.txt"

  echo "=== Directive status $(date -Iseconds) s=$SESSION_NUM ===" > "$STATUS_FILE"

  if [ ! -f "$DIRECTIVES_FILE" ]; then
    echo "ERROR: directives.json not found" >> "$STATUS_FILE"
    echo "Directive status: directives.json missing"
    return
  fi

  # Uses pre-computed runner output (r-prehook-runner.mjs) instead of node subprocess
  local RUNNER_OK
  RUNNER_OK=$(echo "$RUNNER_JSON" | jq -r '.directive_analysis.text // empty' 2>/dev/null || true)
  local RUNNER_ERR
  RUNNER_ERR=$(echo "$RUNNER_JSON" | jq -r '.directive_analysis.error // empty' 2>/dev/null || true)

  local OUTPUT
  if [ -n "$RUNNER_ERR" ] || [ -z "$RUNNER_OK" ]; then
    echo "ERROR: r-prehook-runner directive-analysis failed: $RUNNER_ERR" >> "$STATUS_FILE"
    echo "Directive status: analysis failed"
    return
  fi
  OUTPUT="$RUNNER_OK"

  echo "$OUTPUT" >> "$STATUS_FILE"

  local NEEDS_ATTENTION
  NEEDS_ATTENTION=$(echo "$OUTPUT" | grep -cE '^(STALE|NEEDS_UPDATE|PENDING)' || true)

  if [ "$NEEDS_ATTENTION" -eq 0 ]; then
    echo "Directive status: healthy, step 5 = add review note"
  else
    echo "Directive status: $NEEDS_ATTENTION need attention"
  fi

  # Append to maintain-audit.txt for visibility
  echo "" >> "$AUDIT_FILE"
  cat "$STATUS_FILE" >> "$AUDIT_FILE"
}

###############################################################################
# Check 4: Brainstorming health gate (was 44-brainstorm-gate_R.sh)
#   Ensures ≥3 active brainstorming ideas
###############################################################################
check_brainstorm_gate() {
  local BRAINSTORM="$DIR/BRAINSTORMING.md"
  local MIN_IDEAS=3

  if [ ! -f "$BRAINSTORM" ]; then
    echo "brainstorm-gate: BRAINSTORMING.md not found"
    return
  fi

  local TOTAL_ACTIVE FRESH_COUNT
  TOTAL_ACTIVE=$(grep -cE '^- \*\*' "$BRAINSTORM" 2>/dev/null || echo 0)
  FRESH_COUNT=$(grep -cE '^- \*\*.+\(added ~s[0-9]+\)' "$BRAINSTORM" 2>/dev/null || echo 0)

  if [ "$FRESH_COUNT" -lt "$MIN_IDEAS" ]; then
    local MSG="WARN: BRAINSTORMING.md has only $FRESH_COUNT active idea(s) (minimum: $MIN_IDEAS). You MUST add $(($MIN_IDEAS - $FRESH_COUNT))+ new ideas before closing this R session."
    echo "$MSG"
    echo "" >> "$AUDIT_FILE"
    echo "=== Brainstorming health ===" >> "$AUDIT_FILE"
    echo "$MSG" >> "$AUDIT_FILE"
  else
    echo "brainstorm-gate: $FRESH_COUNT fresh ideas ($TOTAL_ACTIVE total active) (healthy)"
  fi
}

###############################################################################
# Run all checks sequentially, then summarize
###############################################################################

check_maintain_audit
check_security_posture
check_directive_status
check_brainstorm_gate

if [ "$ISSUES" -eq 0 ]; then
  echo "ALL CLEAR: security, disk, API, logs, hooks, git posture all healthy" >> "$AUDIT_FILE"
else
  echo "TOTAL: $ISSUES issue(s) flagged" >> "$AUDIT_FILE"
fi

echo "Maintain audit: $ISSUES issue(s)"
