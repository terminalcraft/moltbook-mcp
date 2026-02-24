#!/bin/bash
# Pre-session: track session file line counts and flag cognitive load issues
# Created by B#196 (wq-152), expanded by B#198 (wq-155)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT="$DIR/session-file-sizes.json"
HISTORY="$DIR/session-file-sizes-history.json"
THRESHOLD=150  # Lines threshold for cognitive load warning
HISTORY_LIMIT=50  # Keep last N snapshots for trend analysis

# Count lines in session files (SESSION_*.md + BRIEFING.md + pinchwork-protocol.md)
declare -A sizes
max_file=""
max_lines=0
warnings=""
total_lines=0

# Track SESSION_*.md files
for f in "$DIR"/SESSION_*.md; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  lines=$(wc -l < "$f")
  sizes[$name]=$lines
  total_lines=$((total_lines + lines))

  if [ "$lines" -gt "$max_lines" ]; then
    max_lines=$lines
    max_file=$name
  fi

  if [ "$lines" -gt "$THRESHOLD" ]; then
    warnings="${warnings:+$warnings, }$name ($lines lines)"
  fi
done

# Track BRIEFING.md
if [ -f "$DIR/BRIEFING.md" ]; then
  lines=$(wc -l < "$DIR/BRIEFING.md")
  sizes["BRIEFING.md"]=$lines
  total_lines=$((total_lines + lines))
  if [ "$lines" -gt "$THRESHOLD" ]; then
    warnings="${warnings:+$warnings, }BRIEFING.md ($lines lines)"
  fi
fi

# Track extracted protocol files
if [ -f "$DIR/pinchwork-protocol.md" ]; then
  lines=$(wc -l < "$DIR/pinchwork-protocol.md")
  sizes["pinchwork-protocol.md"]=$lines
  total_lines=$((total_lines + lines))
fi

# Build current snapshot JSON
current_snapshot=$(cat <<EOF
{
  "timestamp": "$(date -Iseconds)",
  "session": ${SESSION_NUM:-0},
  "threshold": $THRESHOLD,
  "files": {
$(first=true; for name in "${!sizes[@]}"; do $first || echo ","; first=false; printf '    "%s": %d' "$name" "${sizes[$name]}"; done)
  },
  "total_lines": $total_lines,
  "max_file": "$max_file",
  "max_lines": $max_lines,
  "warning": $([ -n "$warnings" ] && echo "\"Files exceeding threshold: $warnings\"" || echo "null")
}
EOF
)

# Write current snapshot
echo "$current_snapshot" > "$OUTPUT"

# Append to history (maintain last N entries)
if [ -f "$HISTORY" ]; then
  # Read existing history, append new entry, keep last N
  node -e "
    const fs = require('fs');
    const history = JSON.parse(fs.readFileSync('$HISTORY', 'utf8'));
    const snapshot = JSON.parse(\`$current_snapshot\`);
    history.snapshots.push(snapshot);
    if (history.snapshots.length > $HISTORY_LIMIT) {
      history.snapshots = history.snapshots.slice(-$HISTORY_LIMIT);
    }
    fs.writeFileSync('$HISTORY', JSON.stringify(history, null, 2));
  " 2>/dev/null || true
else
  # Initialize history file
  node -e "
    const fs = require('fs');
    const snapshot = JSON.parse(\`$current_snapshot\`);
    const history = { version: 1, snapshots: [snapshot] };
    fs.writeFileSync('$HISTORY', JSON.stringify(history, null, 2));
  " 2>/dev/null || true
fi

# Log warning if any files exceed threshold
if [ -n "$warnings" ]; then
  echo "SESSION_FILE_SIZE_WARNING: $warnings (threshold: $THRESHOLD lines)" >&2
fi

# Token budget check (added B#416, wq-556) + auto-queue (wq-582)
TOKEN_RESULT=$(node "$DIR/token-budget-estimator.mjs" --json 2>/dev/null || true)
if [ -n "$TOKEN_RESULT" ]; then
  TOKEN_WARNS=$(echo "$TOKEN_RESULT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); if(d.warnings>0) d.files.filter(f=>f.overBudget).forEach(f=>console.log(f.file+': '+f.tokens+' tokens'))" 2>/dev/null || true)
  if [ -n "$TOKEN_WARNS" ]; then
    echo "TOKEN_BUDGET_WARNING: Files over 3000-token threshold:" >&2
    echo "$TOKEN_WARNS" | while read -r line; do echo "  $line" >&2; done

    # Auto-generate work-queue items for over-budget files (wq-582)
    node -e "
      const fs = require('fs');
      const result = JSON.parse(\`$TOKEN_RESULT\`);
      const wqPath = '$DIR/work-queue.json';
      const wq = JSON.parse(fs.readFileSync(wqPath, 'utf8'));
      const existing = (wq.queue || []).map(i => (i.title + ' ' + (i.description || '')).toLowerCase());
      const overBudget = result.files.filter(f => f.overBudget);
      let added = 0;
      for (const f of overBudget) {
        // Skip if a pending/in-progress item already targets this file
        const fname = f.file.toLowerCase();
        const hasItem = existing.some(t => t.includes(fname) && (t.includes('slim') || t.includes('token') || t.includes('prompt-budget')));
        if (hasItem) continue;
        // Generate next wq ID
        const ids = wq.queue.map(i => parseInt(i.id.replace('wq-',''),10)).filter(n=>!isNaN(n));
        const nextId = 'wq-' + (Math.max(...ids) + 1 + added);
        wq.queue.push({
          id: nextId,
          title: 'Slim ' + f.file + ' — ' + f.tokens + ' tokens (over ' + result.threshold + ' budget)',
          description: 'Auto-generated: ' + f.file + ' is ' + f.tokens + ' tokens, exceeding the ' + result.threshold + '-token prompt budget. Extract sections, compress, or split to reduce cognitive load.',
          priority: parseInt(nextId.replace('wq-',''),10),
          status: 'pending',
          added: new Date().toISOString().split('T')[0],
          created_session: ${SESSION_NUM:-0},
          source: 'hook:27-session-file-sizes',
          tags: ['auto-seeded', 'prompt-budget'],
          commits: []
        });
        added++;
      }
      if (added > 0) {
        fs.writeFileSync(wqPath, JSON.stringify(wq, null, 2) + '\n');
        process.stderr.write('TOKEN_BUDGET_AUTO_QUEUE: Added ' + added + ' work-queue item(s) for over-budget files\n');
      }
    " 2>&1 | while read -r line; do echo "$line" >&2; done || true
  fi
fi
