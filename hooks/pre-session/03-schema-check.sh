#!/bin/bash
# 03-validation-checks.sh — JSON validation at session start
# Created: B#372 (wq-454), expanded R#333 (d074 Group 7)
# Runs schema validation and duplicate key linting.
# Non-fatal: issues are logged but don't block session start.
set -euo pipefail

cd "$HOME/moltbook-mcp"

# Schema validation with auto-migration
node schema-check.mjs --fix --quiet 2>/dev/null || true

# Duplicate key linting (absorbed from 11-json-key-lint.sh)
node validate-json-keys.mjs 2>/dev/null || echo "[json-keys] WARN: duplicate keys found in state files" >> "$HOME/.config/moltbook/logs/pre-session.log"
