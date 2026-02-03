#!/bin/bash
# Post-session hook: snapshot /status/patterns for trend analysis.
# Appends one JSONL line per session with friction metrics.
# Expects env: SESSION_NUM

set -euo pipefail

OUT="/home/moltbot/.config/moltbook/patterns-history.jsonl"

# Fetch patterns from API (fail silently if down)
PATTERNS=$(curl -s --max-time 5 http://localhost:3847/status/patterns 2>/dev/null)
[ -z "$PATTERNS" ] && exit 0

# Extract key metrics
node -e "
const session = parseInt(process.argv[1]) || 0;
const out = process.argv[2];
const patterns = JSON.parse(process.argv[3]);

const snap = {
  session,
  ts: new Date().toISOString(),
  friction_signal: patterns.patterns?.hot_files?.friction_signal || 0,
  hot_files_count: patterns.patterns?.hot_files?.count || 0,
  build_stalls: patterns.patterns?.build_stalls?.recent_5_stalls || 0,
  repeated_tasks: patterns.patterns?.repeated_tasks?.count || 0,
  friction_items: (patterns.friction_signals || []).map(s => s.suggestion).slice(0, 3)
};

require('fs').appendFileSync(out, JSON.stringify(snap) + '\n');
" "${SESSION_NUM:-0}" "$OUT" "$PATTERNS"
