#!/bin/bash
# Compress session JSONL logs by stripping bulky fields (originalFile from Edit results).
# Saves ~50% disk space while preserving the audit trail (structuredPatch kept).
# Runs on current session log. Marker files (.compressed) track processed files.
#
# Migrated from python3 to node (wq-728, B#485)

LOG_DIR="$HOME/.claude/projects/-home-moltbot"
cd "$LOG_DIR" 2>/dev/null || exit 0

compress_jsonl() {
    local f="$1"
    [ -f "$f" ] || return 0
    [ -f "${f}.compressed" ] && return 0

    local before=$(stat -c%s "$f" 2>/dev/null || echo 0)
    [ "$before" -lt 50000 ] && { touch "${f}.compressed"; return 0; }

    node -e "
const fs = require('fs');
const file = process.argv[1];
const lines = fs.readFileSync(file, 'utf8').split('\n');
let modified = false;
const out = [];
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    const obj = JSON.parse(trimmed);
    const tr = obj.toolUseResult;
    if (tr && tr.originalFile && tr.originalFile !== '[compressed]') {
      tr.originalFile = '[compressed]';
      modified = true;
    }
    out.push(JSON.stringify(obj));
  } catch {
    out.push(trimmed);
  }
}
if (modified) {
  fs.writeFileSync(file + '.tmp', out.join('\n') + '\n');
  fs.renameSync(file + '.tmp', file);
}
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
