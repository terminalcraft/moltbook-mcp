#!/usr/bin/env bash
# stale-ref-check.sh — Finds truly stale references (deleted from git AND missing from disk)
# Used by A sessions during infrastructure health audits.
# Filters out gitignored-but-present files to prevent false positives.
#
# Performance: Uses single grep pass with alternation pattern instead of
# N separate grep -rl scans. Reduces 42-file scan from ~6s to <1s.
# Optimized: R#292 s1659

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

# is_structural_ref — check if a match line is structural (not prose/comment/fence)
# Args: $1=ref_file path, $2=matching line number, $3=matching line content
is_structural_ref_line() {
  local ref_file="$1"
  local lineno="$2"
  local line_content="$3"

  # For JSON files, filter out prose fields
  if [[ "$ref_file" == *.json ]]; then
    if echo "$line_content" | grep -qE '"(content|description|note|title|summary|body)"'; then
      return 1
    fi
    return 0
  fi

  # For shell files, filter out comment lines
  if [[ "$ref_file" == *.sh ]]; then
    if echo "$line_content" | grep -qE '^[[:space:]]*#'; then
      return 1
    fi
    return 0
  fi

  # For markdown files, filter out code fences and blockquotes
  if [[ "$ref_file" == *.md ]]; then
    # Skip blockquotes
    if echo "$line_content" | grep -qP '^[[:space:]]*>'; then
      return 1
    fi
    # Check if inside a code fence — count opening ``` before this line
    local fence_count
    fence_count=$(head -n "$lineno" "$ref_file" 2>/dev/null | grep -c '^```' || true)
    # Odd count means inside a fence
    if [ $((fence_count % 2)) -eq 1 ]; then
      return 1
    fi
    return 0
  fi

  # All other file types: always structural
  return 0
}

# Build alternation pattern from all basenames for single grep pass
declare -A basename_to_file
basenames=()
for file in $truly_deleted; do
  bn=$(basename "$file")
  basename_to_file["$bn"]="$file"
  basenames+=("$bn")
done

# Escape dots in basenames for grep pattern, build alternation
pattern_parts=()
for bn in "${basenames[@]}"; do
  escaped=$(echo "$bn" | sed 's/\./\\./g')
  pattern_parts+=("$escaped")
done
# Join with | for grep -E alternation
IFS='|' ; grep_pattern="${pattern_parts[*]}" ; IFS=' '

# Single grep pass: get all matches with file:line_number:content
TMP_MATCHES=$(mktemp)
trap "rm -f $TMP_MATCHES" EXIT

grep -rnE "$grep_pattern" \
  --include="*.sh" --include="*.mjs" --include="*.js" --include="*.md" --include="*.json" \
  "${ARCHIVE_EXCLUDES[@]}" ~/moltbook-mcp/ \
  > "$TMP_MATCHES" 2>/dev/null || true

found_stale=0

# For each deleted file, check if any matches reference its basename structurally
for file in $truly_deleted; do
  bn=$(basename "$file")
  # Filter matches for this specific basename
  file_matches=$(grep -F "$bn" "$TMP_MATCHES" || true)
  [ -z "$file_matches" ] && continue

  filtered_refs=""
  while IFS= read -r match_line; do
    [ -z "$match_line" ] && continue
    # Parse: /path/to/ref_file:lineno:content
    ref_file=$(echo "$match_line" | cut -d: -f1)
    lineno=$(echo "$match_line" | cut -d: -f2)
    content=$(echo "$match_line" | cut -d: -f3-)

    if is_structural_ref_line "$ref_file" "$lineno" "$content"; then
      # Deduplicate by ref_file (only need one structural match per file)
      if ! echo "$filtered_refs" | grep -qF "$ref_file"; then
        filtered_refs="$filtered_refs$ref_file"$'\n'
      fi
    fi
  done <<< "$file_matches"

  filtered_refs=$(echo "$filtered_refs" | sed '/^$/d')
  if [ -n "$filtered_refs" ]; then
    echo "STALE: $file — referenced in:"
    echo "$filtered_refs" | sed 's|/home/moltbot/moltbook-mcp/||' | sed 's/^/  /'
    found_stale=1
  fi
done

if [ "$found_stale" -eq 0 ]; then
  echo "No stale references found for truly deleted files."
fi
