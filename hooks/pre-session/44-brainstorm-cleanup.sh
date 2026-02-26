#!/bin/bash
# Pre-hook: Brainstorming cleanup (consolidated from wq-598 + wq-167/wq-609)
#
# Phase 1 (all sessions): Strip struck-through lines from BRAINSTORMING.md
# Phase 2 (A sessions only): Auto-retire stale ideas (>30s) and observations (>50s)
#
# Phase 2 runs first so newly retired entries get cleaned up by Phase 1.

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BRAINSTORM="$DIR/BRAINSTORMING.md"
SESSION=${SESSION_NUM:-0}
CURRENT_MODE="${MODE_CHAR:-B}"

if [ ! -f "$BRAINSTORM" ]; then
  exit 0
fi

# --- Phase 2: Auto-retire stale entries (A sessions only) ---
if [ "$CURRENT_MODE" = "A" ]; then
  IDEA_THRESHOLD=30
  OBS_THRESHOLD=50

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

  // Retire stale ideas
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

  // Retire stale observations with session markers (wq-609)
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

  COUNTS=$(echo "$RETIRED" | tail -1)
  IDEA_COUNT=$(echo "$COUNTS" | cut -d, -f1)
  OBS_COUNT=$(echo "$COUNTS" | cut -d, -f2)

  if [ "${IDEA_COUNT:-0}" -gt 0 ] 2>/dev/null || [ "${OBS_COUNT:-0}" -gt 0 ] 2>/dev/null; then
    echo "[brainstorm-cleanup] Retired $IDEA_COUNT ideas, $OBS_COUNT observations"
  fi
fi

# --- Phase 1: Strip struck-through lines (all sessions) ---
struck=$(grep -cE '^\s*-\s*~~.*~~' "$BRAINSTORM" 2>/dev/null) || struck=0

if [ "$struck" -eq 0 ]; then
  exit 0
fi

# Remove lines with struck-through entries (- ~~...~~ with any trailing content)
sed -i '/^\s*-\s*~~.*~~/d' "$BRAINSTORM"

# Clean up any resulting double-blank-lines
sed -i '/^$/N;/^\n$/d' "$BRAINSTORM"

echo "[brainstorm-cleanup] Removed $struck struck-through entries"
