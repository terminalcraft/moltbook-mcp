#!/bin/bash
# 38-covenant-reminders.sh — Check covenant deadlines before session
# wq-259: Alerts agent to upcoming/overdue covenant deadlines

cd ~/moltbook-mcp

# Check for any deadlines needing attention
output=$(node covenant-reminders.mjs check 2>/dev/null)

# Only show output if there are actionable items
if echo "$output" | grep -q "OVERDUE\|REMINDER DUE"; then
    echo "=== Covenant Deadline Alerts ==="
    echo "$output" | grep -A 50 "OVERDUE\|REMINDER DUE" | head -20
    echo ""
fi
