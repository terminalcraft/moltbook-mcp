#!/bin/bash
# Pre-session: periodic EVM wallet balance check (every 70 sessions).
# Extracted from heartbeat.sh inline block (R#222).
# Checks USDC balance across chains. Alerts on deposits or unexpected drops.
# Results logged to evm-balance.json, alerts to evm-balance-alert.txt.

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
LOG_DIR="${LOG_DIR:-$STATE_DIR/logs}"

COUNTER="${SESSION_NUM:-0}"
INTERVAL=70

# Skip if not on the interval boundary
if [ $((COUNTER % INTERVAL)) -ne 0 ] || [ "$COUNTER" -eq 0 ]; then
  exit 0
fi

EVM_PREV_FILE="$STATE_DIR/evm-balance.json"
# wq-705: Replaced python3 with jq for JSON parsing
PREV_TOTAL=0
if [ -f "$EVM_PREV_FILE" ]; then
  PREV_TOTAL=$(jq -r '.total_usdc // 0' "$EVM_PREV_FILE" 2>/dev/null || echo "0")
fi

# Run balance check (writes to evm-balance.json)
EVM_OUTPUT=$(node "$DIR/check-evm-balance.mjs" --json 2>&1 || echo '{"total_usdc":0,"error":"check failed"}')
NEW_TOTAL=$(echo "$EVM_OUTPUT" | jq -r '.total_usdc // 0' 2>/dev/null || echo "0")

# Alert conditions
ALERT=""
# 1. USDC appeared (deposit detected) - prev was 0, now > 0
if [ "$(echo "$PREV_TOTAL" | awk '{print ($1 == 0)}')" = "1" ] && [ "$(echo "$NEW_TOTAL" | awk '{print ($1 > 0)}')" = "1" ]; then
  ALERT="DEPOSIT_DETECTED: ${NEW_TOTAL} USDC appeared"
# 2. Balance dropped unexpectedly (>10% decrease)
elif [ "$(echo "$PREV_TOTAL $NEW_TOTAL" | awk '{print ($1 > 0.01 && $2 < $1 * 0.9)}')" = "1" ]; then
  ALERT="BALANCE_DROP: ${PREV_TOTAL} -> ${NEW_TOTAL} USDC"
fi

if [ -n "$ALERT" ]; then
  echo "$(date -Iseconds) s=$COUNTER: $ALERT" >> "$STATE_DIR/evm-balance-alert.txt"
fi

echo "$(date -Iseconds) evm-balance-check: s=$COUNTER prev=${PREV_TOTAL} new=${NEW_TOTAL} alert=${ALERT:-none}" >> "$LOG_DIR/selfmod.log"
