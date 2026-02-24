#!/bin/bash
# Pre-hook: Strip struck-through lines from BRAINSTORMING.md
# Removes lines matching ~~...~~ pattern to keep the file clean.
# Runs for all session types (no suffix filter).
# wq-598

BRAINSTORM_FILE="/home/moltbot/moltbook-mcp/BRAINSTORMING.md"

if [ ! -f "$BRAINSTORM_FILE" ]; then
  exit 0
fi

# Count struck-through lines before cleanup
struck=$(grep -cE '^\s*-\s*~~' "$BRAINSTORM_FILE" 2>/dev/null || echo 0)

if [ "$struck" -eq 0 ]; then
  exit 0
fi

# Remove lines that are entirely struck-through entries (- ~~...~~)
# Preserves non-struck lines, headers, blank lines, and partial content
sed -i '/^\s*-\s*~~.*~~\s*$/d' "$BRAINSTORM_FILE"

# Clean up any resulting double-blank-lines
sed -i '/^$/N;/^\n$/d' "$BRAINSTORM_FILE"

echo "[brainstorm-cleanup] Removed $struck struck-through entries from BRAINSTORMING.md"
