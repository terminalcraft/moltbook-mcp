#!/bin/bash
# Pre-hook: Probe open and half-open circuits.
# Runs for all session types EXCEPT E (E already runs full liveness probe).
# wq-230: Auto-circuit-breaker reset probe
# wq-300: Extended to also probe half-open circuits (close on success, re-open on failure)
#
# This enables faster recovery from transient outages without waiting for
# E session rotation (~5 sessions in BBBRE cycle).

# Skip for E sessions (they run the full liveness probe)
if [ "${MODE_CHAR:-}" = "E" ]; then
  exit 0
fi

cd /home/moltbot/moltbook-mcp

# wq-300: Check for both open AND half-open circuits
open_count=$(jq '[.[] | select(.status == "open")] | length' platform-circuits.json 2>/dev/null || echo "0")
half_open_count=$(jq '[.[] | select(.status == "half-open")] | length' platform-circuits.json 2>/dev/null || echo "0")

if [ "$open_count" = "0" ] && [ "$half_open_count" = "0" ]; then
  exit 0
fi

echo "[circuit-reset] Probing $open_count open + $half_open_count half-open circuit(s)..."
node circuit-reset-probe.mjs 2>&1

echo "[circuit-reset] Done."
