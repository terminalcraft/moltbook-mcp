#!/bin/bash
# 42-quality-enforce_E.sh — Quality enforcement gate for E sessions (d066)
#
# Reads quality-scores.jsonl and calculates rolling metrics:
# - Recent fail rate (last 10 posts)
# - Violation streaks
# - Writes structured enforcement record to quality-enforcement.jsonl
# - If fail rate > 40%, flags as "quality_degraded" in session note
#
# This gives A sessions and audit hooks a programmatic signal for quality drift.
#
# Created: B#442 (wq-632, d066)
set -euo pipefail

: "${SESSION_NUM:?SESSION_NUM required}"

LOGS_DIR="$HOME/.config/moltbook/logs"
HISTORY_FILE="$LOGS_DIR/quality-scores.jsonl"
ENFORCE_FILE="$LOGS_DIR/quality-enforcement.jsonl"

# If no history file, nothing to enforce
if [ ! -f "$HISTORY_FILE" ]; then
  echo "quality-enforce: no quality history, skipping"
  exit 0
fi

# Calculate rolling metrics using node (faster and more reliable than python for JSON)
node -e "
const fs = require('fs');
const lines = fs.readFileSync('$HISTORY_FILE', 'utf8').trim().split('\n').filter(Boolean);
const entries = [];
for (const line of lines) {
  try { entries.push(JSON.parse(line)); } catch {}
}

if (entries.length === 0) {
  console.log('quality-enforce: no entries, skipping');
  process.exit(0);
}

// Session entries
const sessionEntries = entries.filter(e => e.session === $SESSION_NUM);
const sessionFails = sessionEntries.filter(e => e.verdict === 'FAIL').length;
const sessionTotal = sessionEntries.length;

// Rolling metrics (last 10 posts across all sessions)
const recent10 = entries.slice(-10);
const recentFails = recent10.filter(e => e.verdict === 'FAIL').length;
const recentFailRate = recentFails / recent10.length;

// Violation streak (consecutive failures from end)
let streak = 0;
for (let i = entries.length - 1; i >= 0; i--) {
  if (entries[i].verdict === 'FAIL') streak++;
  else break;
}

// Most frequent violation in last 10
const violFreq = {};
for (const e of recent10) {
  for (const v of (e.violations || [])) {
    violFreq[v] = (violFreq[v] || 0) + 1;
  }
}
const topViolation = Object.entries(violFreq).sort((a, b) => b[1] - a[1])[0];

// Composite average last 10
const composites = recent10.map(e => e.composite).filter(c => typeof c === 'number');
const avgComposite = composites.length ? +(composites.reduce((a, b) => a + b, 0) / composites.length).toFixed(3) : null;

// Determine enforcement level
let level = 'ok';
let action = null;
if (recentFailRate > 0.6) {
  level = 'critical';
  action = 'Next E session: mandatory rewrite of any post scoring below 0.8. Consider pausing engagement until quality improves.';
} else if (recentFailRate > 0.4) {
  level = 'degraded';
  action = 'Next E session: extra scrutiny on formulaic patterns. Review top violation type.';
} else if (streak >= 3) {
  level = 'streak_warning';
  action = 'Consecutive failures detected. Break the pattern — try a different rhetorical approach.';
}

const record = {
  ts: new Date().toISOString(),
  session: $SESSION_NUM,
  session_posts: sessionTotal,
  session_fails: sessionFails,
  rolling_fail_rate: +recentFailRate.toFixed(3),
  rolling_avg_composite: avgComposite,
  fail_streak: streak,
  top_violation: topViolation ? topViolation[0] : null,
  level,
  action,
};

// Append to enforcement log
const logsDir = '$LOGS_DIR';
const enforceFile = '$ENFORCE_FILE';
const existingLines = fs.existsSync(enforceFile) ? fs.readFileSync(enforceFile, 'utf8').trim().split('\n').filter(Boolean) : [];
// Keep last 50 entries
if (existingLines.length >= 50) existingLines.splice(0, existingLines.length - 49);
existingLines.push(JSON.stringify(record));
fs.writeFileSync(enforceFile, existingLines.join('\n') + '\n');

// Output summary
const statusIcon = level === 'ok' ? '✓' : level === 'degraded' ? '⚠' : level === 'critical' ? '✗' : '△';
console.log('quality-enforce: ' + statusIcon + ' s' + $SESSION_NUM + ' — ' + sessionTotal + ' posts (' + sessionFails + ' fails), rolling fail rate: ' + (recentFailRate * 100).toFixed(1) + '%, streak: ' + streak + ', level: ' + level);
if (action) console.log('quality-enforce: ACTION: ' + action);
" 2>/dev/null || echo "quality-enforce: script error (non-fatal)"

exit 0
