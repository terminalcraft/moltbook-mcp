#!/bin/bash
# Pre-session hook (B sessions): Warn when pipeline gate violations are high (wq-696)
# Advisory only — prints reminder, never blocks session.

DIR="$(cd "$(dirname "$0")/../.." && pwd)"

violations=$(node -e "
const stats = JSON.parse(require('child_process').execSync('node $DIR/audit-stats.mjs', {encoding:'utf8'}));
const v = (stats.b_pipeline_gate && stats.b_pipeline_gate.violation_count) || 0;
process.stdout.write(String(v));
" 2>/dev/null)

if [ -n "$violations" ] && [ "$violations" -ge 3 ] 2>/dev/null; then
  echo "⚠ PIPELINE GATE: $violations recent B sessions consumed queue items without contributing replacements."
  echo "  Remember: every consumed queue item should produce at least 1 replacement (queue item or brainstorming idea)."
fi

exit 0
