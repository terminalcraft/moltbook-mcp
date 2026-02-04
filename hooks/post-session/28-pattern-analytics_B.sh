#!/bin/bash
# Post-hook: Track B session pattern capture compliance and analytics.
# Parses session output for "Pattern capture: X" statements and updates tracking.
# wq-231: B session pattern capture analytics
#
# Only runs for B sessions (enforced by _B.sh filename suffix).

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
TRACKING_FILE="$STATE_DIR/pattern-capture-tracking.json"
SUMMARY_FILE="${LOG_FILE%.log}.summary"

: "${SESSION_NUM:?SESSION_NUM required}"

# Initialize tracking file if not exists
if [ ! -f "$TRACKING_FILE" ]; then
  echo '{"sessions":[],"stats":{"total":0,"captured":0,"skipped":0,"missing":0},"tags":{}}' > "$TRACKING_FILE"
fi

# Parse pattern capture statement from summary
pattern_line=""
if [ -f "$SUMMARY_FILE" ]; then
  pattern_line=$(grep -i "Pattern capture:" "$SUMMARY_FILE" | head -1 || true)
fi

# Determine capture status
status="missing"
tag=""
if [ -n "$pattern_line" ]; then
  if echo "$pattern_line" | grep -qi "none\|routine"; then
    status="skipped"
  elif echo "$pattern_line" | grep -qi "captured"; then
    status="captured"
    # Extract tag if present (e.g., "captured debugging approach")
    tag=$(echo "$pattern_line" | sed -n 's/.*captured \([a-z]*\).*/\1/p' | tr '[:upper:]' '[:lower:]')
  fi
fi

# Update tracking file
node -e "
const fs = require('fs');
const path = '$TRACKING_FILE';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));

// Add session entry (keep last 50)
data.sessions = data.sessions.slice(-49);
data.sessions.push({
  session: ${SESSION_NUM},
  status: '${status}',
  tag: '${tag}' || null,
  timestamp: new Date().toISOString()
});

// Update stats
data.stats.total++;
if ('${status}' === 'captured') {
  data.stats.captured++;
  if ('${tag}') {
    data.tags['${tag}'] = (data.tags['${tag}'] || 0) + 1;
  }
} else if ('${status}' === 'skipped') {
  data.stats.skipped++;
} else {
  data.stats.missing++;
}

// Compute rates
const recent = data.sessions.slice(-10);
const recentCaptured = recent.filter(s => s.status === 'captured').length;
const recentSkipped = recent.filter(s => s.status === 'skipped').length;
const recentMissing = recent.filter(s => s.status === 'missing').length;

data.recent = {
  window: 10,
  captured: recentCaptured,
  skipped: recentSkipped,
  missing: recentMissing,
  capture_rate: Math.round(recentCaptured / Math.max(1, recent.length) * 100),
  compliance_rate: Math.round((recentCaptured + recentSkipped) / Math.max(1, recent.length) * 100)
};

data.last_updated = new Date().toISOString();

fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');

console.log('[pattern-analytics] s${SESSION_NUM}: ${status}' + ('${tag}' ? ' (${tag})' : '') +
  ' | Recent: ' + recentCaptured + '/' + recent.length + ' captured, ' +
  data.recent.compliance_rate + '% compliance');
"

exit 0
