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

# 5. Hook health: surface consistently failing or slow hooks from recent sessions.
# Reads structured JSON from pre/post-hook-results.json (written by run-hooks.sh).
# Flags: (a) hooks failing >50% in last 5 sessions, (b) hooks averaging >5000ms,
# (c) total hook time >60s per session (budget drain).
for results_file in "$HOME/.config/moltbook/logs/pre-hook-results.json" "$HOME/.config/moltbook/logs/post-hook-results.json"; do
  [ -f "$results_file" ] || continue
  PHASE=$(basename "$results_file" | sed 's/-hook-results.json//')

  HOOK_ANALYSIS=$(python3 -c "
import json, sys
from collections import defaultdict

results_file, phase = sys.argv[1], sys.argv[2]
lines = open(results_file).readlines()
recent = []
for line in lines[-5:]:
    line = line.strip()
    if not line:
        continue
    try:
        recent.append(json.loads(line))
    except json.JSONDecodeError:
        continue

if not recent:
    sys.exit(0)

hook_stats = defaultdict(lambda: {'runs': 0, 'fails': 0, 'total_ms': 0})
session_totals = []

for entry in recent:
    session_total_ms = 0
    for h in entry.get('hooks', []):
        name = h.get('hook', '?')
        ms = h.get('ms', 0)
        status = h.get('status', '')
        hook_stats[name]['runs'] += 1
        if status.startswith('fail'):
            hook_stats[name]['fails'] += 1
        hook_stats[name]['total_ms'] += ms
        session_total_ms += ms
    session_totals.append(session_total_ms)

for name, stats in sorted(hook_stats.items()):
    if stats['runs'] >= 2 and stats['fails'] / stats['runs'] > 0.5:
        pct = int(100 * stats['fails'] / stats['runs'])
        print(f'WARN: {phase} hook {name} failing {pct}% ({stats[\"fails\"]}/{stats[\"runs\"]} recent sessions)')

for name, stats in sorted(hook_stats.items()):
    avg_ms = stats['total_ms'] / stats['runs'] if stats['runs'] > 0 else 0
    if avg_ms > 5000:
        # wq-472: Add fix recommendations based on hook characteristics
        fix = ''
        if 'liveness' in name or 'health' in name or 'balance' in name:
            fix = ' → FIX: add time-based cache or move to periodic cron'
        elif 'engagement' in name or 'intel' in name:
            fix = ' → FIX: reduce API calls or add short-circuit on empty state'
        elif avg_ms > 15000:
            fix = ' → FIX: split into async background task'
        else:
            fix = ' → FIX: profile with LOG_DIR debug, check for network calls'
        print(f'WARN: {phase} hook {name} slow (avg {int(avg_ms)}ms across {stats[\"runs\"]} sessions){fix}')

if session_totals:
    avg_total = sum(session_totals) / len(session_totals)
    if avg_total > 60000:
        print(f'WARN: {phase} hooks averaging {int(avg_total/1000)}s total per session (budget drain)')
" "$results_file" "$PHASE" 2>/dev/null || true)

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
