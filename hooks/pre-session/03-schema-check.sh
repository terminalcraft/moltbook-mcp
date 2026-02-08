#!/bin/bash
# 03-schema-check.sh — Validate state file schemas at session start
# Created: B#372 (wq-454)
# Runs schema-check.mjs in quiet+fix mode to auto-migrate missing fields.
# Non-fatal: schema issues are logged but don't block session start.
set -euo pipefail

cd "$HOME/moltbook-mcp"
node schema-check.mjs --fix --quiet 2>/dev/null || true
