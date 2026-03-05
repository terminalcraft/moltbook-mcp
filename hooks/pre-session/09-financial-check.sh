#!/bin/bash
# Pre-hook: Financial autonomy check (wq-354)
# Detects financial blockers before session starts:
# - Low ETH gas when EVM operations might be needed
# - Low USDC when staking/payments scheduled
# - Available XMR not being utilized for swaps
# Emits warning with suggested resolution actions.
#
# Uses timeout-wrapper.sh for per-check timeouts + watchdog (wq-880).

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HOOKS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
ALERT_FILE="$STATE_DIR/financial-alert.txt"

# Only run financial checks on B sessions (where autonomy matters)
if [ "${MODE_CHAR:-}" != "B" ]; then
  exit 0
fi

# Check if base-swap.mjs exists
if [ ! -f "$DIR/base-swap.mjs" ]; then
  exit 0
fi

# Source timeout-wrapper library
source "$HOOKS_DIR/lib/timeout-wrapper.sh"

# Configure timeouts
CHECK_TIMEOUT=3
HOOK_TIMEOUT=5

# Temp files for parallel results
EVM_TMPFILE=$(mktemp)
XMR_TMPFILE=$(mktemp)
trap 'rm -f "$EVM_TMPFILE" "$XMR_TMPFILE" 2>/dev/null' EXIT

export DIR

# Run EVM balance check
tw_run "evm-balance" bash -c '
  output=$(node "'"$DIR"'/base-swap.mjs" balance 2>/dev/null) || output="FAIL"
  echo "$output" > "'"$EVM_TMPFILE"'"
'

# Run XMR balance check
tw_run "xmr-balance" bash -c '
  if [ -f "'"$DIR"'/check-balance.cjs" ]; then
    output=$(node "'"$DIR"'/check-balance.cjs" 2>/dev/null) || output="0"
  else
    output="0"
  fi
  echo "$output" > "'"$XMR_TMPFILE"'"
'

# Wait for both checks (watchdog kills stragglers after HOOK_TIMEOUT)
tw_wait

# Parse EVM results
BALANCE_OUTPUT=$(cat "$EVM_TMPFILE" 2>/dev/null || echo "FAIL")

if echo "$BALANCE_OUTPUT" | grep -q "FAIL"; then
  echo "financial-check: balance fetch failed or timed out"
  exit 0
fi

ETH_RAW=$(echo "$BALANCE_OUTPUT" | grep -oP 'ETH: \K[0-9.]+' || echo "0")
USDC_RAW=$(echo "$BALANCE_OUTPUT" | grep -oP 'USDC: \K[0-9.]+' || echo "0")

# Use bc for decimal comparison if available, else use awk
eth_low() {
  if command -v bc &>/dev/null; then
    [ "$(echo "$ETH_RAW < 0.0001" | bc -l)" = "1" ]
  else
    awk "BEGIN {exit !($ETH_RAW < 0.0001)}"
  fi
}

usdc_sufficient() {
  if command -v bc &>/dev/null; then
    [ "$(echo "$USDC_RAW > 5" | bc -l)" = "1" ]
  else
    awk "BEGIN {exit !($USDC_RAW > 5)}"
  fi
}

# Parse XMR results
XMR_OUTPUT=$(cat "$XMR_TMPFILE" 2>/dev/null || echo "0")
XMR_RAW=$(echo "$XMR_OUTPUT" | grep -oP 'Balance: \K[0-9.]+' || echo "0")

# Build alert if needed
ALERT=""

# Low ETH + available swap source = suggest swap
if eth_low && usdc_sufficient; then
  ALERT="## FINANCIAL AUTONOMY ALERT

**Issue**: Low ETH for gas ($ETH_RAW ETH) but have $USDC_RAW USDC

**Resolution**: Run autonomous gas swap:
\`\`\`bash
node base-swap.mjs swap 2
\`\`\`
This will convert ~2 USDC to ETH for gas.

"
fi

# XMR available but not being used
xmr_check() {
  if command -v bc &>/dev/null; then
    [ "$(echo "$XMR_RAW > 0.01" | bc -l)" = "1" ]
  else
    awk "BEGIN {exit !($XMR_RAW > 0.01)}"
  fi
}

if xmr_check && eth_low; then
  ALERT="${ALERT}**Note**: XMR balance ($XMR_RAW XMR) available for swap to ETH if needed.
"
fi

# Write alert or clean up
if [ -n "$ALERT" ]; then
  echo "$ALERT" > "$ALERT_FILE"
  echo "⚠ financial-check: Low gas detected, swap available (see $ALERT_FILE)"
else
  rm -f "$ALERT_FILE" 2>/dev/null || true
  echo "financial-check: ok (ETH: $ETH_RAW, USDC: $USDC_RAW)"
fi
