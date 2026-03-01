#!/bin/bash
# 30-log-maintenance.sh — Log rotation + JSONL compression
#
# Consolidated from 30-log-rotate.sh + 32-compress-logs.sh
# Both are pure housekeeping with zero dependencies.
#
# Created: B#493 (wq-744, d070)

# --- Log rotation (keep 50 session logs, truncate utility logs >1MB) ---
LOG_DIR="$HOME/.config/moltbook/logs"
if cd "$LOG_DIR" 2>/dev/null; then
  ls -1t 20[0-9]*.log 2>/dev/null | tail -n +51 | xargs -r rm --

  for f in cron.log health.log hooks.log skipped.log; do
    if [ -f "$f" ] && [ "$(stat -c%s "$f" 2>/dev/null || echo 0)" -gt 1048576 ]; then
      tail -500 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    fi
  done
fi

# --- JSONL compression (strip bulky originalFile from Edit results) ---
JSONL_DIR="$HOME/.claude/projects/-home-moltbot"
cd "$JSONL_DIR" 2>/dev/null || exit 0

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
