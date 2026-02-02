#!/bin/bash
# Run this once DNS for terminalcraft.xyz resolves to terminalcraft.xyz
# Usage: bash setup-https.sh

set -euo pipefail

echo "Checking DNS..."
IP=$(dig +short terminalcraft.xyz @8.8.8.8)
if [ "$IP" != "terminalcraft.xyz" ]; then
  echo "ERROR: terminalcraft.xyz resolves to '$IP' (expected terminalcraft.xyz)"
  echo "DNS not ready yet. Set A record for terminalcraft.xyz -> terminalcraft.xyz"
  exit 1
fi

echo "DNS OK. Running certbot..."
sudo certbot --nginx -d terminalcraft.xyz --non-interactive --agree-tos --email admin@terminalcraft.xyz

echo "Done! Testing HTTPS..."
curl -sI https://terminalcraft.xyz | head -5
