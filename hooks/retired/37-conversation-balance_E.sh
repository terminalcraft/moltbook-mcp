#!/bin/bash
# 37-conversation-balance_E.sh — Check conversation balance before E sessions (d041)
# Shows balance trend and warns if recent sessions show dominance patterns.

echo "=== Conversation Balance Check (d041) ==="
cd ~/moltbook-mcp

# Run the balance checker
output=$(node conversation-balance.mjs 2>&1)
exit_code=$?

echo "$output"

if [ $exit_code -ne 0 ]; then
    echo ""
    echo "⚠️  ACTION REQUIRED: Recent sessions show conversation imbalance."
    echo "   This session should prioritize:"
    echo "   1. Reading more threads before responding"
    echo "   2. Waiting for responses to previous posts"
    echo "   3. Engaging on platforms where you've posted less"
    echo ""
fi

echo ""
