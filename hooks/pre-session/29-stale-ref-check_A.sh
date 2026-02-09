#!/bin/bash
# 29-stale-ref-check_A.sh — Automated stale-reference detection for A sessions
#
# Runs stale-ref-check.sh and writes structured results to stale-refs.json
# for the audit report to consume. Makes stale-reference detection fully automated
# (previously done manually during A sessions).
#
# Created: B#390 s1372 (wq-508)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
OUTPUT_FILE="$STATE_DIR/stale-refs.json"

# Run stale-ref-check.sh and capture output
RAW_OUTPUT=$("$DIR/stale-ref-check.sh" 2>/dev/null) || {
  # Script failed — write empty result, don't block session
  echo '{"checked":"'"$(date -Iseconds)"'","session":'"${SESSION_NUM:-0}"',"stale_count":0,"stale_refs":[],"error":"stale-ref-check.sh failed"}' > "$OUTPUT_FILE"
  exit 0
}

# Parse output into structured JSON using python3
python3 -c "
import json, sys, re
from datetime import datetime

raw = '''$RAW_OUTPUT'''
session = int('${SESSION_NUM:-0}')

stale_refs = []
current_file = None

for line in raw.split('\n'):
    line = line.strip()
    if line.startswith('STALE:'):
        # Format: STALE: <file> — referenced in:
        match = re.match(r'STALE:\s+(\S+)', line)
        if match:
            current_file = match.group(1)
    elif line and current_file and not line.startswith('===') and not line.startswith('No ') and not line.startswith('All '):
        # Reference line (indented file path)
        ref_file = line.strip()
        stale_refs.append({
            'deleted_file': current_file,
            'referenced_in': ref_file
        })

result = {
    'checked': datetime.now().isoformat(),
    'session': session,
    'stale_count': len(stale_refs),
    'stale_refs': stale_refs,
    'has_stale': len(stale_refs) > 0
}

with open('$OUTPUT_FILE', 'w') as f:
    json.dump(result, f, indent=2)

# Output summary for session context
if stale_refs:
    files = set(r['deleted_file'] for r in stale_refs)
    print(f'stale-ref-check: {len(stale_refs)} stale reference(s) in {len(files)} deleted file(s)')
else:
    print('stale-ref-check: clean (0 stale references)')
" 2>/dev/null || {
  # Python parsing failed — write raw output as fallback
  echo '{"checked":"'"$(date -Iseconds)"'","session":'"${SESSION_NUM:-0}"',"stale_count":0,"stale_refs":[],"error":"parse failed","raw":"'"${RAW_OUTPUT:0:500}"'"}' > "$OUTPUT_FILE"
}

exit 0
