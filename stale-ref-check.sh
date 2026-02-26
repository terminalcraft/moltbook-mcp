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

# is_structural_ref — for JSON files, verify the match is a structural reference
# (not just mentioned in a content/description/note/title prose field)
is_structural_ref() {
  local ref_file="$1"
  local search_term="$2"
  local all_matches non_noise

  all_matches=$(grep -n "$search_term" "$ref_file" 2>/dev/null || true)
  [ -z "$all_matches" ] && return 1

  # For JSON files, filter out prose fields
  if [[ "$ref_file" == *.json ]]; then
    local prose_pattern='"(content|description|note|title|summary|body)"'
    non_noise=$(echo "$all_matches" | grep -Ev "$prose_pattern" || true)
    [ -n "$non_noise" ] && return 0
    return 1
  fi

  # For shell files, filter out comment lines (lines starting with optional whitespace + #)
  if [[ "$ref_file" == *.sh ]]; then
    non_noise=$(echo "$all_matches" | grep -Ev '^[0-9]+:[[:space:]]*#' || true)
    [ -n "$non_noise" ] && return 0
    return 1
  fi

  # For markdown files, filter out code fences and blockquotes (wq-673)
  if [[ "$ref_file" == *.md ]]; then
    # Get line numbers of matches
    local match_lines
    match_lines=$(echo "$all_matches" | grep -oP '^\d+' || true)
    [ -z "$match_lines" ] && return 1

    # Build set of lines inside code fences using awk
    local fenced_lines
    fenced_lines=$(awk '/^```/{inside=!inside; next} inside{print NR}' "$ref_file" 2>/dev/null || true)

    non_noise=""
    while IFS= read -r lineno; do
      [ -z "$lineno" ] && continue
      # Skip if inside a code fence
      if echo "$fenced_lines" | grep -qx "$lineno" 2>/dev/null; then
        continue
      fi
      # Skip if line is a blockquote (starts with >)
      local line_content
      line_content=$(echo "$all_matches" | grep -P "^${lineno}:" | head -1)
      if echo "$line_content" | grep -qP '^\d+:[[:space:]]*>' 2>/dev/null; then
        continue
      fi
      non_noise="yes"
      break
    done <<< "$match_lines"

    [ -n "$non_noise" ] && return 0
    return 1
  fi

  # All other file types: always structural
  return 0
}

for file in $truly_deleted; do
  basename=$(basename "$file")
  refs=$(grep -rl "$basename" --include="*.sh" --include="*.mjs" --include="*.js" --include="*.md" --include="*.json" "${ARCHIVE_EXCLUDES[@]}" ~/moltbook-mcp/ 2>/dev/null || true)
  if [ -n "$refs" ]; then
    # Filter refs to exclude false positives from prose fields in JSON
    filtered_refs=""
    while IFS= read -r ref; do
      [ -z "$ref" ] && continue
      if is_structural_ref "$ref" "$basename"; then
        filtered_refs="$filtered_refs$ref"$'\n'
      fi
    done <<< "$refs"
    filtered_refs=$(echo "$filtered_refs" | sed '/^$/d')
    if [ -n "$filtered_refs" ]; then
      echo "STALE: $file — referenced in:"
      echo "$filtered_refs" | sed 's|/home/moltbot/moltbook-mcp/||' | sed 's/^/  /'
      found_stale=1
    fi
  fi
done

if [ "$found_stale" -eq 0 ]; then
  echo "No stale references found for truly deleted files."
fi
