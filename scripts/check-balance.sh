#!/bin/bash
# Check Monero wallet balance via MyMonero light wallet server
# Usage: ./check-balance.sh
# Reads wallet.json from parent directory

DIR="$(cd "$(dirname "$0")/.." && pwd)"
WALLET="$DIR/wallet.json"

if [ ! -f "$WALLET" ]; then
  echo "ERROR: wallet.json not found at $WALLET"
  exit 1
fi

ADDRESS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$WALLET','utf8')).address)")
VIEW_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$WALLET','utf8')).view_key)")

RESPONSE=$(curl -s --max-time 30 -X POST "https://api.mymonero.com:8443/get_address_info" \
  -H "Content-Type: application/json" \
  -d "{\"address\":\"$ADDRESS\",\"view_key\":\"$VIEW_KEY\"}")

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  echo "ERROR: Failed to reach MyMonero API"
  exit 1
fi

node -e "
const r = JSON.parse(process.argv[1]);
const received = BigInt(r.total_received || '0');
const sent = BigInt(r.total_sent || '0');
const locked = BigInt(r.locked_funds || '0');
const balance = received - sent;
const unlocked = balance - locked;
const xmrBal = Number(balance) / 1e12;
const xmrUnlocked = Number(unlocked) / 1e12;
const usdRate = r.rates?.USD || 0;
console.log('Address: ' + r.scanned_block_height + '/' + r.blockchain_height + ' blocks scanned');
console.log('Balance: ' + xmrBal.toFixed(12) + ' XMR (\$' + (xmrBal * usdRate).toFixed(2) + ' USD)');
if (locked !== 0n) console.log('Locked:  ' + (Number(locked)/1e12).toFixed(12) + ' XMR');
console.log('XMR/USD: \$' + usdRate);
" "$RESPONSE"
