#!/bin/bash
# 22-session-snapshots.sh — Snapshot ecosystem state + pattern metrics to JSONL
#
# Consolidated from 22-ecosystem-snapshot.sh + 23-pattern-snapshot.sh
# Both append one JSONL line per session. Combined for d070 hook reduction.
# JS logic extracted to hooks/lib/session-snapshots.mjs (R#327, d074).
#
# Expects env: SESSION_NUM
# Created: B#493 (wq-744, d070)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# Fetch pattern data for the pattern snapshot
PATTERNS=$(curl -s --max-time 5 http://localhost:3847/status/patterns 2>/dev/null) || true

# Run the snapshot module — pass patterns via env to avoid shell escaping issues
PATTERNS_JSON="$PATTERNS" node "$DIR/hooks/lib/session-snapshots.mjs" "$DIR" "${SESSION_NUM:-0}"
