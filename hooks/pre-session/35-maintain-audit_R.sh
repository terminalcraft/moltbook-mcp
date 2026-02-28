#!/bin/bash
# Pre-session maintenance audit for R sessions.
# Replaces the manual maintain checklist — runs automatically and logs warnings.
# Only runs on R sessions (enforced by _R.sh filename suffix since R#101).
# Added s383: retire evolve/maintain split, automate routine checks.
# R#201: Added hook health check (step 5) — surfaces failing/slow hooks from
# structured tracking data. Closes feedback loop where hook performance was
# measured but never surfaced for R session action.

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
AUDIT_FILE="$HOME/.config/moltbook/maintain-audit.txt"

echo "=== Maintenance audit $(date -Iseconds) s=${SESSION_NUM:-?} ===" > "$AUDIT_FILE"

# 1. Security: check sensitive file permissions
ISSUES=0
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

# 5. Directive audit log errors (absorbed from retired 25-session-diagnostics.sh)
AUDIT_LOG="$HOME/.config/moltbook/logs/directive-audit.log"
if [ -f "$AUDIT_LOG" ]; then
  RECENT_ERRORS=$(tail -5 "$AUDIT_LOG" | grep -c "ERROR" || true)
  if [ "$RECENT_ERRORS" -gt 0 ]; then
    echo "WARN: $RECENT_ERRORS recent directive-audit errors — check directive-audit.log" >> "$AUDIT_FILE"
    ISSUES=$((ISSUES + 1))
  fi
fi

# 6. Hook health: surface consistently failing or slow hooks from recent sessions.
# Reads structured JSON from pre/post-hook-results.json (written by run-hooks.sh).
# Flags: (a) hooks failing >50% in last 5 sessions, (b) hooks averaging >5000ms,
# (c) total hook time >60s per session (budget drain).
# R#276: Replaced 60-line inline Python with jq — eliminates python3 dependency.
for results_file in "$HOME/.config/moltbook/logs/pre-hook-results.json" "$HOME/.config/moltbook/logs/post-hook-results.json"; do
  [ -f "$results_file" ] || continue
  PHASE=$(basename "$results_file" | sed 's/-hook-results.json//')

  # Take last 5 entries (one per session) and analyze with jq
  HOOK_ANALYSIS=$(tail -5 "$results_file" | jq -rs --arg phase "$PHASE" '
    # Parse lines into array of session entries
    [.[] | select(. == null | not)] as $recent |
    if ($recent | length) == 0 then empty else

    # Aggregate per-hook stats
    [
      $recent[].hooks[]? |
      { hook, status, ms: (.ms // 0) }
    ] | group_by(.hook) | map({
      name: .[0].hook,
      runs: length,
      fails: [.[] | select(.status | startswith("fail"))] | length,
      total_ms: [.[].ms] | add
    }) as $stats |

    # (a) Hooks failing >50% with >=2 runs
    [ $stats[] | select(.runs >= 2 and (.fails / .runs) > 0.5) |
      "WARN: \($phase) hook \(.name) failing \((.fails * 100 / .runs) | floor)% (\(.fails)/\(.runs) recent sessions)"
    ] +

    # (b) Hooks averaging >5000ms
    [ $stats[] | select((.total_ms / .runs) > 5000) |
      (.total_ms / .runs | floor) as $avg |
      "WARN: \($phase) hook \(.name) slow (avg \($avg)ms across \(.runs) sessions)" +
      if (.name | test("liveness|health|balance")) then " → FIX: add time-based cache or move to periodic cron"
      elif (.name | test("engagement|intel")) then " → FIX: reduce API calls or add short-circuit on empty state"
      elif $avg > 15000 then " → FIX: split into async background task"
      else " → FIX: profile with LOG_DIR debug, check for network calls" end
    ] +

    # (c) Total hook time >60s per session
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

if [ "$ISSUES" -eq 0 ]; then
  echo "ALL CLEAR: security, disk, API, logs, hooks all healthy" >> "$AUDIT_FILE"
else
  echo "TOTAL: $ISSUES issue(s) flagged" >> "$AUDIT_FILE"
fi

echo "Maintain audit: $ISSUES issue(s)"
