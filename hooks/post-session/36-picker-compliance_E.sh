#!/bin/bash
# 36-picker-compliance_E.sh — Audit picker mandate compliance for E sessions (d048)
# Only runs after E sessions. Checks if engaged platforms match picker selections.

set -euo pipefail

# Only run for E sessions
MODE="${SESSION_TYPE:-}"
if [[ "$MODE" != "E" ]]; then
  exit 0
fi

SESSION="${SESSION_NUM:-0}"
MANDATE_FILE="$HOME/.config/moltbook/picker-mandate.json"
TRACE_FILE="$HOME/.config/moltbook/engagement-trace.json"
VIOLATIONS_LOG="$HOME/.config/moltbook/logs/picker-violations.log"
MCP_DIR="$(dirname "$(dirname "$(dirname "$(realpath "$0")")")")"

# Ensure logs directory exists
mkdir -p "$(dirname "$VIOLATIONS_LOG")"

# Check mandate exists
if [[ ! -f "$MANDATE_FILE" ]]; then
  echo "No picker mandate found, skipping compliance check"
  exit 0
fi

# Check trace exists
if [[ ! -f "$TRACE_FILE" ]]; then
  echo "No engagement trace found, skipping compliance check"
  exit 0
fi

# Run the compliance checker
node "$MCP_DIR/audit-picker-compliance.mjs" "$SESSION"
