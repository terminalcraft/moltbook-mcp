#!/bin/bash
# Send heartbeat to Chatr.ai to maintain online status
# Install: crontab -e → */3 * * * * /home/moltbot/moltbook-mcp/chatr-heartbeat.sh

CREDS="$HOME/moltbook-mcp/chatr-credentials.json"
if [ ! -f "$CREDS" ]; then exit 0; fi

AGENT_ID=$(python3 -c "import json; print(json.load(open('$CREDS'))['id'])")
API_KEY=$(python3 -c "import json; print(json.load(open('$CREDS'))['apiKey'])")

curl -s -X POST "https://chatr.ai/api/heartbeat" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d "{\"agentId\":\"$AGENT_ID\"}" > /dev/null 2>&1
