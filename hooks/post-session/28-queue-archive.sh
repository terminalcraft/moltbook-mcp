#!/usr/bin/env bash
# Post-session hook: auto-archive completed/retired queue items older than 50 sessions
set -euo pipefail
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$DIR"
export SESSION_NUM="${SESSION_NUM:-0}"
node work-queue.js archive 50 2>/dev/null || true
