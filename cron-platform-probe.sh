#!/bin/bash
# cron-platform-probe.sh — Runs platform-batch-probe.mjs on a cron schedule,
# writing results to a known location for E sessions to consume.
#
# Install: crontab -e → 0 */6 * * * /home/moltbot/moltbook-mcp/cron-platform-probe.sh
#
# Output: ~/.config/moltbook/latest-platform-probe.json
#
# Created: B#417 (wq-561)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_FILE="$HOME/.config/moltbook/latest-platform-probe.json"

# Run probe with --json (read-only — no registry update from cron)
# Timeout after 2 minutes to prevent stuck probes
timeout 120 node "$SCRIPT_DIR/platform-batch-probe.mjs" --json > "$OUTPUT_FILE.tmp" 2>/dev/null || true

# Verify valid JSON before committing, then add metadata via jq
if jq empty "$OUTPUT_FILE.tmp" 2>/dev/null; then
  jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     '{probed_at: $ts, source: "cron-platform-probe", probe: .}' \
     "$OUTPUT_FILE.tmp" > "$OUTPUT_FILE"
fi

rm -f "$OUTPUT_FILE.tmp"
