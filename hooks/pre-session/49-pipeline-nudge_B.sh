#!/bin/bash
# Pre-session hook (B sessions): Pipeline gate compliance nudge (wq-696, wq-706)
# Advisory only — prints reminder, never blocks session.
# Strengthened in s1601: shows specific compliance rate and concrete obligation.

DIR="$(cd "$(dirname "$0")/../.." && pwd)"

THRESHOLD="${PIPELINE_NUDGE_THRESHOLD:-3}"

# Get both violation count and compliance rate
stats=$(node -e "
const stats = JSON.parse(require('child_process').execSync('SESSION_NUM=${SESSION_NUM:-0} node $DIR/audit-stats.mjs', {encoding:'utf8'}));
const g = stats.b_pipeline_gate || {};
const v = g.violation_count || 0;
const rate = g.rate || 'N/A';
process.stdout.write(JSON.stringify({v, rate}));
" 2>/dev/null)

violations=$(echo "$stats" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(String(d.v))" 2>/dev/null || echo 0)
rate=$(echo "$stats" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.rate)" 2>/dev/null || echo "?/?")

if [ -n "$violations" ] && [ "$violations" -ge "$THRESHOLD" ] 2>/dev/null; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  ⚠ PIPELINE GATE COMPLIANCE: $rate ($violations violations)    "
  echo "║                                                              ║"
  echo "║  OBLIGATION: Before closing this session, you MUST:          ║"
  echo "║  → Add ≥1 new pending queue item OR brainstorming idea       ║"
  echo "║  → Do this BEFORE marking your task done                     ║"
  echo "║  → Sources: adjacent improvements, missing tests, tooling    ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
fi

exit 0
