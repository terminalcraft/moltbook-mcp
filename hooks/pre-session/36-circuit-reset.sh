#!/bin/bash
# Pre-hook: Probe open and half-open circuits.
# Runs for all session types EXCEPT E (E already runs full liveness probe).
# wq-230: Auto-circuit-breaker reset probe
# wq-300: Extended to also probe half-open circuits (close on success, re-open on failure)
# wq-312: Added open-circuit-repair for defunct detection
# wq-407: Added 5s timeout per probe + self-skip after 3 consecutive failures
#
# This enables faster recovery from transient outages without waiting for
# E session rotation (~5 sessions in BBBRE cycle).

# Skip for E sessions (they run the full liveness probe).
# Reset failure counter so B sessions resume probing after E runs.
if [ "${MODE_CHAR:-}" = "E" ]; then
  FAIL_TRACKER="$HOME/.config/moltbook/circuit-reset-failures.txt"
  [ -f "$FAIL_TRACKER" ] && echo "0" > "$FAIL_TRACKER"
  exit 0
fi

cd /home/moltbot/moltbook-mcp

FAIL_TRACKER="$HOME/.config/moltbook/circuit-reset-failures.txt"
PROBE_TIMEOUT=5  # seconds — if service doesn't respond in 5s, it's still down

# Circuit-breaker self-skip: after 3+ consecutive failures, skip probing
if [ -f "$FAIL_TRACKER" ]; then
  CONSEC_FAILS=$(cat "$FAIL_TRACKER" 2>/dev/null || echo "0")
  if [ "$CONSEC_FAILS" -ge 3 ] 2>/dev/null; then
    echo "[circuit-reset] Self-skip: $CONSEC_FAILS consecutive probe failures, skipping (reset on next E session)"
    exit 0
  fi
fi

# wq-300: Check for both open AND half-open circuits
open_count=$(jq '[.[] | select(.status == "open")] | length' platform-circuits.json 2>/dev/null || echo "0")
half_open_count=$(jq '[.[] | select(.status == "half-open")] | length' platform-circuits.json 2>/dev/null || echo "0")

if [ "$open_count" = "0" ] && [ "$half_open_count" = "0" ]; then
  # No circuits to probe — reset failure counter
  [ -f "$FAIL_TRACKER" ] && echo "0" > "$FAIL_TRACKER"
  exit 0
fi

echo "[circuit-reset] Probing $open_count open + $half_open_count half-open circuit(s) (timeout=${PROBE_TIMEOUT}s)..."

PROBE_FAILED=0

# wq-312: Use repair workflow for open circuits (handles recovery + defunct detection)
if [ "$open_count" -gt 0 ]; then
  echo "[circuit-repair] Running open circuit repair workflow..."
  if ! timeout "${PROBE_TIMEOUT}s" node open-circuit-repair.mjs 2>&1; then
    echo "[circuit-repair] Timed out or failed after ${PROBE_TIMEOUT}s"
    PROBE_FAILED=1
  fi
fi

# Use reset probe for half-open circuits
if [ "$half_open_count" -gt 0 ]; then
  echo "[circuit-reset] Probing half-open circuits..."
  if ! timeout "${PROBE_TIMEOUT}s" node circuit-reset-probe.mjs 2>&1; then
    echo "[circuit-reset] Timed out or failed after ${PROBE_TIMEOUT}s"
    PROBE_FAILED=1
  fi
fi

# Track consecutive failures for self-skip logic
if [ "$PROBE_FAILED" = "1" ]; then
  PREV=$(cat "$FAIL_TRACKER" 2>/dev/null || echo "0")
  echo "$(( PREV + 1 ))" > "$FAIL_TRACKER"
  echo "[circuit-reset] Probe failed (consecutive: $(cat "$FAIL_TRACKER"))"
else
  echo "0" > "$FAIL_TRACKER"
fi

echo "[circuit-reset] Done."
