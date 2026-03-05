#!/bin/bash
# 19-manifest-sync.sh — Lightweight manifest drift detection (all session types)
#
# Runs before 20-auto-commit.sh so regenerated manifest gets committed.
# R sessions create/rename hooks during refactoring; this catches drift
# regardless of session type (previously only B posthook detected it).
#
# wq-857: extracted from 47-b-session-posthook_B.sh check_manifest_drift()
set -uo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFEST="$DIR/hooks/manifest.json"

# Skip if generate-hook-manifest.mjs doesn't exist
[ -f "$DIR/generate-hook-manifest.mjs" ] || exit 0

if [ ! -f "$MANIFEST" ]; then
  echo "manifest-sync: WARN — manifest.json missing, regenerating"
  (cd "$DIR" && SESSION_NUM="${SESSION_NUM:-0}" node generate-hook-manifest.mjs 2>/dev/null) || true
  (cd "$DIR" && git add hooks/manifest.json 2>/dev/null) || true
  exit 0
fi

# Count hooks on disk vs manifest
DISK_COUNT=0
for subdir in pre-session post-session mode-transform; do
  if [ -d "$DIR/hooks/$subdir" ]; then
    DISK_COUNT=$((DISK_COUNT + $(ls -1 "$DIR/hooks/$subdir/"*.sh 2>/dev/null | wc -l)))
  fi
done

MANIFEST_COUNT=$(node -e "try{const m=JSON.parse(require('fs').readFileSync('$MANIFEST','utf8'));console.log(m.hooks?m.hooks.length:0)}catch{console.log(0)}" 2>/dev/null || echo "0")

if [ "$DISK_COUNT" -ne "$MANIFEST_COUNT" ]; then
  echo "manifest-sync: FIXING — disk=$DISK_COUNT manifest=$MANIFEST_COUNT, regenerating"
  (cd "$DIR" && SESSION_NUM="${SESSION_NUM:-0}" node generate-hook-manifest.mjs 2>/dev/null) || true
  (cd "$DIR" && git add hooks/manifest.json 2>/dev/null) || true
else
  echo "manifest-sync: OK — $DISK_COUNT hooks"
fi
