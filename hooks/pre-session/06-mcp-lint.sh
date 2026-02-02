#!/bin/bash
# Pre-hook: MCP tool call linting (wq-013)
# Validates index.js component registrations before session starts.
# Catches: missing files, syntax errors, TDZ issues.

set -euo pipefail

DIR="/home/moltbot/moltbook-mcp"
INDEX="$DIR/index.js"
ERRORS=()
COMP_COUNT=0

# 1. Extract imported component files from index.js
mapfile -t COMPONENTS < <(grep -oP 'from "\./components/\K[^"]+' "$INDEX" || true)

if [ ${#COMPONENTS[@]} -eq 0 ]; then
  echo "mcp-lint: no components found in index.js (unexpected)"
  exit 0
fi

# 2. Check each component file
for comp in "${COMPONENTS[@]}"; do
  filepath="$DIR/components/$comp"
  COMP_COUNT=$((COMP_COUNT + 1))

  if [ ! -f "$filepath" ]; then
    ERRORS+=("MISSING: $comp does not exist")
    continue
  fi

  if ! node --check "$filepath" 2>/dev/null; then
    ERRORS+=("SYNTAX: $comp has syntax errors")
    continue
  fi
done

# 3. Also check core files
for core in index.js transforms/scoping.js providers/api.js providers/replay-log.js; do
  filepath="$DIR/$core"
  if [ -f "$filepath" ]; then
    if ! node --check "$filepath" 2>/dev/null; then
      ERRORS+=("SYNTAX: $core has syntax errors")
    fi
  fi
done

# 4. Dry-run import of each component individually (catches TDZ, runtime init errors)
for comp in "${COMPONENTS[@]}"; do
  filepath="$DIR/components/$comp"
  [ -f "$filepath" ] || continue
  if ! timeout 5 node -e "import('$filepath').catch(e => { console.error(e.message); process.exit(1); })" 2>/tmp/mcp-lint-err; then
    msg=$(head -1 /tmp/mcp-lint-err)
    ERRORS+=("IMPORT: $comp — $msg")
  fi
done
rm -f /tmp/mcp-lint-err

# 5. Report
if [ ${#ERRORS[@]} -eq 0 ]; then
  echo "mcp-lint: all $COMP_COUNT components OK"
else
  echo "⚠ mcp-lint: ${#ERRORS[@]} error(s) found:"
  for e in "${ERRORS[@]}"; do
    echo "  - $e"
  done
  ALERT_FILE="$HOME/.config/moltbook/mcp-lint-alert.txt"
  {
    echo "## MCP LINT ALERT"
    echo "Pre-session linting found ${#ERRORS[@]} error(s) in MCP server code:"
    for e in "${ERRORS[@]}"; do
      echo "- $e"
    done
    echo ""
    echo "Fix these before doing other work — broken tools waste the entire session budget."
  } > "$ALERT_FILE"
  echo "mcp-lint: alert written to $ALERT_FILE"
fi
