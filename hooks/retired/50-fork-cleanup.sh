#!/bin/bash
# 50-fork-cleanup.sh — Clean up stale session forks
# Runs before each session to prevent old exploratory snapshots from accumulating.
# Forks older than 3 days are auto-removed (they're likely forgotten).

cd ~/moltbook-mcp
node session-fork.mjs cleanup 3 2>/dev/null || true
