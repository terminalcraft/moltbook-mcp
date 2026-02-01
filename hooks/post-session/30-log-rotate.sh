#!/bin/bash
# Rotate old session logs (keep 50)
LOG_DIR="$HOME/.config/moltbook/logs"
cd "$LOG_DIR" 2>/dev/null || exit 0
ls -1t *.log 2>/dev/null | tail -n +51 | xargs -r rm --

# Truncate utility logs >1MB (keep last 500 lines)
for f in cron.log health.log hooks.log chatr-flush.log skipped.log; do
  [ -f "$f" ] && [ "$(stat -c%s "$f" 2>/dev/null || echo 0)" -gt 1048576 ] && tail -500 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done
