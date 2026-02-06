#!/bin/bash
# Pre-session covenant ceiling gate for R sessions (wq-382).
# Checks active covenant count against ceiling (default: 20).
# Writes WARNING to maintain-audit.txt when at/over ceiling.
# R sessions must retire a dormant partner before forming new covenants.
# Only runs on R sessions (enforced by _R.sh filename suffix).

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
AUDIT_FILE="$HOME/.config/moltbook/maintain-audit.txt"
CEILING=20

# Run ceiling check via covenant-templates.mjs
CEILING_JSON=$(cd "$DIR" && node covenant-templates.mjs ceiling --json 2>/dev/null | sed -n '/^--- JSON Output ---$/,$ p' | tail -n +2)

if [ -z "$CEILING_JSON" ]; then
  echo "covenant-ceiling: could not run ceiling check"
  exit 0
fi

ACTIVE_COUNT=$(echo "$CEILING_JSON" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{try{console.log(JSON.parse(d).activeCount)}catch{console.log(0)}})")
AT_CEILING=$(echo "$CEILING_JSON" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{try{console.log(JSON.parse(d).atCeiling)}catch{console.log(false)}})")

if [ "$AT_CEILING" = "true" ]; then
  # Get top retirement candidate
  TOP_CANDIDATE=$(echo "$CEILING_JSON" | node -e "
    process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try {
        const data = JSON.parse(d);
        const top = data.retirementCandidates[0];
        if (top) console.log(top.name + ' (' + top.sessionsSinceLastSeen + ' sessions inactive)');
        else console.log('none available');
      } catch { console.log('unknown'); }
    })
  ")

  MSG="WARN: Covenant ceiling reached (${ACTIVE_COUNT}/${CEILING}). Before forming new covenants in step 2b, you MUST retire a dormant partner first. Recommended: node covenant-templates.mjs retire <agent>. Least active: ${TOP_CANDIDATE}. Run 'node covenant-templates.mjs ceiling' for full list."
  echo "$MSG"
  # Append to audit file so it's visible in the session prompt
  if [ -f "$AUDIT_FILE" ]; then
    echo "" >> "$AUDIT_FILE"
    echo "=== Covenant ceiling ===" >> "$AUDIT_FILE"
    echo "$MSG" >> "$AUDIT_FILE"
  fi
else
  echo "covenant-ceiling: ${ACTIVE_COUNT}/${CEILING} active covenants (under ceiling)"
fi
