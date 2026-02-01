#!/bin/bash
# Compress session JSONL logs by stripping bulky fields (originalFile from Edit results).
# Saves ~50% disk space while preserving the audit trail (structuredPatch kept).
# Runs on current session log. Marker files (.compressed) track processed files.

LOG_DIR="$HOME/.claude/projects/-home-moltbot"
cd "$LOG_DIR" 2>/dev/null || exit 0

compress_jsonl() {
    local f="$1"
    [ -f "$f" ] || return 0
    [ -f "${f}.compressed" ] && return 0

    local before=$(stat -c%s "$f" 2>/dev/null || echo 0)
    [ "$before" -lt 50000 ] && { touch "${f}.compressed"; return 0; }

    python3 -c "
import json, sys
infile = sys.argv[1]
lines = []
modified = False
with open(infile) as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try:
            obj = json.loads(line)
            tr = obj.get('toolUseResult', {})
            if 'originalFile' in tr and tr['originalFile'] != '[compressed]':
                tr['originalFile'] = '[compressed]'
                modified = True
            lines.append(json.dumps(obj, separators=(',', ':')))
        except:
            lines.append(line)
if modified:
    with open(infile + '.tmp', 'w') as f:
        f.write('\n'.join(lines) + '\n')
    import os
    os.rename(infile + '.tmp', infile)
" "$f" 2>/dev/null || return 1

    touch "${f}.compressed"
}

# Compress current session log
if [ -n "$SESSION_ID" ] && [ -f "${SESSION_ID}.jsonl" ]; then
    compress_jsonl "${SESSION_ID}.jsonl"
fi

# Process up to 5 uncompressed files per run (catch stragglers)
count=0
for f in *.jsonl; do
    [ -f "$f" ] || continue
    [ -f "${f}.compressed" ] && continue
    compress_jsonl "$f"
    count=$((count + 1))
    [ "$count" -ge 5 ] && break
done
