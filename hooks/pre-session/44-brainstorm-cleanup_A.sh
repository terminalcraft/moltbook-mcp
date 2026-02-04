#!/bin/bash
# Auto-retire stale brainstorming ideas for A sessions (wq-167)
# Ideas older than 30 sessions without promotion are auto-retired.
# Only runs on A sessions (enforced by _A.sh filename suffix).
#
# This automates the expiry rule in BRAINSTORMING.md so A sessions
# don't have to manually edit the file.

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BRAINSTORM="$DIR/BRAINSTORMING.md"
SESSION=${SESSION_NUM:-0}
STALE_THRESHOLD=30

if [ ! -f "$BRAINSTORM" ]; then
  echo "brainstorm-cleanup: BRAINSTORMING.md not found"
  exit 0
fi

# Use node for reliable parsing and in-place editing
RETIRED=$(node -e "
const fs = require('fs');
const content = fs.readFileSync('$BRAINSTORM', 'utf8');
const session = $SESSION;
const threshold = $STALE_THRESHOLD;

const lines = content.split('\n');
let retired = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // Skip already struck-through lines
  if (line.trim().startsWith('- ~~')) continue;

  // Match active ideas with session markers
  const match = line.match(/^- \*\*(.+?)\*\* \(added ~s(\d+)\)/);
  if (match) {
    const ideaSession = parseInt(match[2]);
    const age = session - ideaSession;
    if (age > threshold) {
      // Strike through the idea
      lines[i] = line.replace(/^- \*\*/, '- ~~**').replace(/\):/, ') — auto-retired s' + session + '~~:');
      retired++;
      process.stderr.write('  Retired: ' + match[1] + ' (age: ' + age + ' sessions)\n');
    }
  }
}

if (retired > 0) {
  fs.writeFileSync('$BRAINSTORM', lines.join('\n'));
}

console.log(retired);
" 2>&1)

# Extract the count (last line of output)
COUNT=$(echo "$RETIRED" | tail -1)

if [ "$COUNT" -gt 0 ] 2>/dev/null; then
  echo "brainstorm-cleanup: retired $COUNT stale ideas"
else
  echo "brainstorm-cleanup: no stale ideas"
fi
