#!/bin/bash
# Auto-commit and push any session changes
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$HOME/.config/moltbook/logs"

cd "$DIR"
if ! git diff --quiet HEAD 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard 2>/dev/null)" ]; then
  git add -- '*.md' '*.js' '*.cjs' '*.mjs' '*.json' '*.sh' '*.py' '*.txt' \
    '.gitignore' 'LICENSE' 2>/dev/null || true
  git add -u 2>/dev/null || true
  # Validate critical shell scripts before committing
  for f in heartbeat.sh; do
    if [ -f "$f" ] && ! bash -n "$f" 2>/dev/null; then
      echo "$(date -Iseconds) REVERTED $f (syntax error)" >> "$LOG_DIR/selfmod.log"
      git checkout HEAD -- "$f" 2>/dev/null || true
    fi
  done
  # Validate critical JSON files before committing (R#294: prevents corrupted queue/directives)
  for f in work-queue.json directives.json; do
    if git diff --cached --name-only 2>/dev/null | grep -qx "$f"; then
      if [ -f "$f" ] && ! node -e 'var d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(d&&typeof d=="object"?0:1)' -- "$f" 2>/dev/null; then
        echo "$(date -Iseconds) REVERTED $f (invalid JSON)" >> "$LOG_DIR/selfmod.log"
        git checkout HEAD -- "$f" 2>/dev/null || true
      fi
    fi
  done
  if ! git diff --cached --quiet 2>/dev/null; then
    git commit -m "auto-snapshot post-session $(date +%Y%m%d_%H%M%S)" --no-gpg-sign 2>/dev/null || true
  fi
fi
git push origin master 2>/dev/null || true
