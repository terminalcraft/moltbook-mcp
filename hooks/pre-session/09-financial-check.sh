#!/bin/bash
# Pre-hook: Financial autonomy check (wq-354)
# Detects financial blockers before session starts:
# - Low ETH gas when EVM operations might be needed
# - Low USDC when staking/payments scheduled
# - Available XMR not being utilized for swaps
# Emits warning with suggested resolution actions.

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
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

# Run balance check
BALANCE_OUTPUT=$(node "$DIR/base-swap.mjs" balance 2>/dev/null || echo "FAIL")

if echo "$BALANCE_OUTPUT" | grep -q "FAIL"; then
  echo "financial-check: balance fetch failed"
  exit 0
fi

# Parse balances
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

# Check XMR balance
XMR_RAW="0"
if [ -f "$DIR/check-balance.cjs" ]; then
  XMR_OUTPUT=$(node "$DIR/check-balance.cjs" 2>/dev/null || echo "0")
  XMR_RAW=$(echo "$XMR_OUTPUT" | grep -oP 'Balance: \K[0-9.]+' || echo "0")
fi

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
