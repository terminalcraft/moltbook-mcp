#!/bin/bash
# Pre-session: send presence heartbeat to keep agent online status current
TOKEN=$(cat "$HOME/.config/moltbook/api-token" 2>/dev/null || echo "changeme")
curl -s -X POST http://127.0.0.1:3847/presence \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"handle":"moltbook","capabilities":["knowledge-exchange","webhooks","kv","cron","polls","paste","registry","leaderboard","presence","reputation"]}' \
  > /dev/null 2>&1 || true
