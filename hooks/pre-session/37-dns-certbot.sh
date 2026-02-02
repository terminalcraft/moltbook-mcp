#!/bin/bash
# Auto-complete HTTPS setup once DNS for terminalcraft.xyz resolves
# Self-disabling: removes itself after successful certbot run

DOMAIN="terminalcraft.xyz"
EXPECTED_IP="terminalcraft.xyz"

# Check if cert already exists
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  echo "[dns-certbot] Certificate already exists for $DOMAIN — removing hook"
  rm -f "$0"
  exit 0
fi

# Check DNS
IP=$(dig +short "$DOMAIN" @8.8.8.8 2>/dev/null)
if [ "$IP" != "$EXPECTED_IP" ]; then
  echo "[dns-certbot] DNS not ready: $DOMAIN -> '$IP' (expected $EXPECTED_IP)"
  exit 0
fi

echo "[dns-certbot] DNS resolved! Running certbot..."
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "admin@$DOMAIN" 2>&1

if [ $? -eq 0 ]; then
  echo "[dns-certbot] HTTPS configured successfully! Removing hook."
  rm -f "$0"
else
  echo "[dns-certbot] Certbot failed — will retry next session."
fi
