#!/bin/bash
# Auto-retire stale brainstorming ideas and observations for A sessions (wq-167, wq-609)
# Ideas older than 30 sessions without promotion are auto-retired.
# Observations older than 50 sessions are auto-retired (wq-609).
# Only runs on A sessions (enforced by _A.sh filename suffix).
#
# This automates the expiry rules in BRAINSTORMING.md so A sessions
# don't have to manually edit the file.

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BRAINSTORM="$DIR/BRAINSTORMING.md"
SESSION=${SESSION_NUM:-0}
IDEA_THRESHOLD=30
OBS_THRESHOLD=50

if [ ! -f "$BRAINSTORM" ]; then
  echo "brainstorm-cleanup: BRAINSTORMING.md not found"
  exit 0
fi

# Use node for reliable parsing and in-place editing
RETIRED=$(node -e "
const fs = require('fs');
const content = fs.readFileSync('$BRAINSTORM', 'utf8');
const session = $SESSION;
const ideaThreshold = $IDEA_THRESHOLD;
const obsThreshold = $OBS_THRESHOLD;

const lines = content.split('\n');
let retiredIdeas = 0;
let retiredObs = 0;
let inObservations = false;
let inIdeas = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // Track which section we're in
  if (line.startsWith('## Active Observations')) { inObservations = true; inIdeas = false; continue; }
  if (line.startsWith('## Evolution Ideas')) { inIdeas = true; inObservations = false; continue; }
  if (line.startsWith('## ') || line.startsWith('---')) { inObservations = false; inIdeas = false; continue; }

  // Skip already struck-through or empty lines
  if (line.trim().startsWith('- ~~') || !line.trim().startsWith('- ')) continue;

  // Retire stale ideas (existing logic)
  if (inIdeas) {
    const match = line.match(/^- \*\*(.+?)\*\* \(added ~s(\d+)\)/);
    if (match) {
      const ideaSession = parseInt(match[2]);
      const age = session - ideaSession;
      if (age > ideaThreshold) {
        lines[i] = line.replace(/^- \*\*/, '- ~~**').replace(/\):/, ') \u2014 auto-retired s' + session + '~~:');
        retiredIdeas++;
        process.stderr.write('  Retired idea: ' + match[1] + ' (age: ' + age + ')\n');
      }
    }
  }

  // wq-609: Retire stale observations with session markers
  if (inObservations) {
    const match = line.match(/~s(\d+)/);
    if (match) {
      const obsSession = parseInt(match[1]);
      const age = session - obsSession;
      if (age > obsThreshold) {
        const summary = line.substring(0, 60).replace(/^- /, '');
        lines[i] = '- ~~' + line.substring(2) + ' \u2014 auto-retired s' + session + '~~';
        retiredObs++;
        process.stderr.write('  Retired observation: ' + summary + '... (age: ' + age + ')\n');
      }
    }
  }
}

const total = retiredIdeas + retiredObs;
if (total > 0) {
  fs.writeFileSync('$BRAINSTORM', lines.join('\n'));
}

console.log(retiredIdeas + ',' + retiredObs);
" 2>&1)

# Extract the counts (last line of output)
COUNTS=$(echo "$RETIRED" | tail -1)
IDEA_COUNT=$(echo "$COUNTS" | cut -d, -f1)
OBS_COUNT=$(echo "$COUNTS" | cut -d, -f2)

if [ "${IDEA_COUNT:-0}" -gt 0 ] 2>/dev/null || [ "${OBS_COUNT:-0}" -gt 0 ] 2>/dev/null; then
  echo "brainstorm-cleanup: retired $IDEA_COUNT ideas, $OBS_COUNT observations"
else
  echo "brainstorm-cleanup: no stale entries"
fi
