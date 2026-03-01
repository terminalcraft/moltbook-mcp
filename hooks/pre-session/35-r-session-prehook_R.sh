#!/bin/bash
# 35-r-session-prehook_R.sh — Consolidated R-session pre-hook dispatcher
#
# Merges 2 individual R-session pre-hooks into a single dispatcher.
# Runs maintenance audit then security posture check, both writing
# to maintain-audit.txt.
#
# Replaces:
#   35-maintain-audit_R.sh    (s383, R#201, R#276)
#   35-security-posture_R.sh  (R#211, d045/d046)
#
# Created: B#490 (wq-729)

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
AUDIT_FILE="$HOME/.config/moltbook/maintain-audit.txt"

ISSUES=0

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
  for results_file in "$HOME/.config/moltbook/logs/pre-hook-results.json" "$HOME/.config/moltbook/logs/post-hook-results.json"; do
    [ -f "$results_file" ] || continue
    PHASE=$(basename "$results_file" | sed 's/-hook-results.json//')

    HOOK_ANALYSIS=$(tail -5 "$results_file" | jq -rs --arg phase "$PHASE" '
      [.[] | select(. == null | not)] as $recent |
      if ($recent | length) == 0 then empty else

      [
        $recent[].hooks[]? |
        { hook, status, ms: (.ms // 0) }
      ] | group_by(.hook) | map({
        name: .[0].hook,
        runs: length,
        fails: [.[] | select(.status | startswith("fail"))] | length,
        total_ms: [.[].ms] | add
      }) as $stats |

      [ $stats[] | select(.runs >= 2 and (.fails / .runs) > 0.5) |
        "WARN: \($phase) hook \(.name) failing \((.fails * 100 / .runs) | floor)% (\(.fails)/\(.runs) recent sessions)"
      ] +

      [ $stats[] | select((.total_ms / .runs) > 5000) |
        (.total_ms / .runs | floor) as $avg |
        "WARN: \($phase) hook \(.name) slow (avg \($avg)ms across \(.runs) sessions)" +
        if (.name | test("liveness|health|balance")) then " → FIX: add time-based cache or move to periodic cron"
        elif (.name | test("engagement|intel")) then " → FIX: reduce API calls or add short-circuit on empty state"
        elif $avg > 15000 then " → FIX: split into async background task"
        else " → FIX: profile with LOG_DIR debug, check for network calls" end
      ] +

      [ $recent | [.[].hooks[]?.ms // 0] |
        (add / ($recent | length)) as $avg_total |
        if $avg_total > 60000 then
          "WARN: \($phase) hooks averaging \(($avg_total / 1000) | floor)s total per session (budget drain)"
        else empty end
      ] |

      .[]

      end
    ' 2>/dev/null || true)

    if [ -n "$HOOK_ANALYSIS" ]; then
      echo "$HOOK_ANALYSIS" >> "$AUDIT_FILE"
      HOOK_ISSUES=$(echo "$HOOK_ANALYSIS" | grep -c "WARN:" || echo 0)
      ISSUES=$((ISSUES + HOOK_ISSUES))
    fi
  done
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
# Run all checks sequentially, then summarize
###############################################################################

check_maintain_audit
check_security_posture

if [ "$ISSUES" -eq 0 ]; then
  echo "ALL CLEAR: security, disk, API, logs, hooks, git posture all healthy" >> "$AUDIT_FILE"
else
  echo "TOTAL: $ISSUES issue(s) flagged" >> "$AUDIT_FILE"
fi

echo "Maintain audit: $ISSUES issue(s)"
