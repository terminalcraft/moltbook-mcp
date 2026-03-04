#!/bin/bash
# 11-json-key-lint.sh — Check critical JSON files for duplicate keys
# Created: B#520 (wq-805)
# Non-fatal: logs warning but doesn't block session start.
cd "$HOME/moltbook-mcp"
node validate-json-keys.mjs 2>/dev/null || echo "[json-keys] WARN: duplicate keys found in state files" >> "$HOME/.config/moltbook/logs/pre-session.log"
