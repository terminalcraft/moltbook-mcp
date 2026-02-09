#!/usr/bin/env bash
# stale-ref-check.sh — Finds truly stale references (deleted from git AND missing from disk)
# Used by A sessions during infrastructure health audits.
# Filters out gitignored-but-present files to prevent false positives.

set -euo pipefail
cd ~/moltbook-mcp

# Step 1: Find files deleted from git in last 60 days
deleted=$(git log --oneline --diff-filter=D --since="60 days ago" --name-only | grep -E '\.(json|js|mjs|sh|md)$' | sort -u)

if [ -z "$deleted" ]; then
  echo "No files deleted from git in last 60 days."
  exit 0
fi

truly_deleted=""
gitignored_present=""

# Step 2: Filter — only keep files that are truly gone from disk
while IFS= read -r file; do
  [ -z "$file" ] && continue
  if [ -f "$file" ]; then
    gitignored_present="$gitignored_present  $file (exists on disk, gitignored — not stale)\n"
  else
    truly_deleted="$truly_deleted $file"
  fi
done <<< "$deleted"

# Report gitignored-but-present files (informational)
if [ -n "$gitignored_present" ]; then
  echo "=== Gitignored but present (NOT stale) ==="
  echo -e "$gitignored_present"
fi

# Step 3: For truly deleted files, check for active references
if [ -z "$(echo "$truly_deleted" | tr -d ' ')" ]; then
  echo "=== No truly stale files found ==="
  echo "All deleted-from-git files still exist on disk (gitignored)."
  exit 0
fi

echo "=== Truly deleted files (checking for stale references) ==="

# Archive/historical files where stale references are expected (not actionable)
ARCHIVE_EXCLUDES=(
  --exclude="work-queue-archive.json"
  --exclude="audit-report.json"
  --exclude="queue-systems-snapshot.json"
  --exclude="dialogue-archive.md"
  --exclude="analytics.json"
  --exclude="directives.json"
  --exclude="patterns.json"
  --exclude-dir="backups"
  --exclude-dir=".git"
)

found_stale=0
for file in $truly_deleted; do
  basename=$(basename "$file")
  refs=$(grep -rl "$basename" --include="*.sh" --include="*.mjs" --include="*.js" --include="*.md" --include="*.json" "${ARCHIVE_EXCLUDES[@]}" ~/moltbook-mcp/ 2>/dev/null || true)
  if [ -n "$refs" ]; then
    echo "STALE: $file — referenced in:"
    echo "$refs" | sed 's|/home/moltbot/moltbook-mcp/||' | sed 's/^/  /'
    found_stale=1
  fi
done

if [ "$found_stale" -eq 0 ]; then
  echo "No stale references found for truly deleted files."
fi
