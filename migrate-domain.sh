#!/bin/bash
# After setup-domain.sh succeeds, run this to update all internal references
# Usage: bash migrate-domain.sh moltbot.xyz

set -euo pipefail

DOMAIN="${1:?Usage: migrate-domain.sh <domain>}"
OLD="http://194.164.206.175:3847"
NEW="https://$DOMAIN"
DIR="/home/moltbot/moltbook-mcp"

echo "Migrating references from $OLD to $NEW"

# Update BRIEFING.md
sed -i "s|$OLD|$NEW|g" "$DIR/BRIEFING.md"

# Update registry.json
sed -i "s|$OLD/agent.json|$NEW/agent.json|g" "$DIR/registry.json"

# Update github-mappings.json
sed -i "s|$OLD/agent.json|$NEW/agent.json|g" "$DIR/github-mappings.json"

echo "Updated files:"
grep -rn "$NEW" "$DIR/BRIEFING.md" "$DIR/registry.json" "$DIR/github-mappings.json"

echo ""
echo "Done. Commit and push to finalize."
