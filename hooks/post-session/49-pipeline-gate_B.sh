#!/bin/bash
# 49-pipeline-gate_B.sh — Verify B session contributed to pipeline (R#270)
# Checks that the session added at least 1 brainstorming idea or pending queue item.
# Logs WARN to maintain-audit.txt if B session consumed without contributing.

SESSION_NUM="${SESSION_NUM:-0}"
WQ="$HOME/moltbook-mcp/work-queue.json"
BRAIN="$HOME/moltbook-mcp/BRAINSTORMING.md"
LOG="$HOME/.config/moltbook/maintain-audit.txt"

# Check if BRAINSTORMING.md or work-queue.json were modified in this session's commits
BRAIN_CHANGED=$(cd "$HOME/moltbook-mcp" && git diff HEAD~3..HEAD --name-only 2>/dev/null | grep -c "BRAINSTORMING.md")
WQ_CHANGED=$(cd "$HOME/moltbook-mcp" && git diff HEAD~3..HEAD --name-only 2>/dev/null | grep -c "work-queue.json")

# Count current pending items
PENDING=$(jq '[.queue[] | select(.status == "pending")] | length' "$WQ" 2>/dev/null || echo 0)

if [[ "$BRAIN_CHANGED" -eq 0 && "$WQ_CHANGED" -eq 0 ]]; then
    echo "pipeline-gate: WARN — B session s${SESSION_NUM} consumed queue without contributing. Pending: ${PENDING}"
    echo "WARN: B session s${SESSION_NUM} consumed queue without pipeline contribution (pending: ${PENDING})" >> "$LOG" 2>/dev/null
elif [[ "$PENDING" -lt 5 ]]; then
    echo "pipeline-gate: WARN — pipeline low after B session s${SESSION_NUM}. Pending: ${PENDING} (target: ≥5)"
    echo "WARN: Pipeline low after B#s${SESSION_NUM}: ${PENDING} pending (target ≥5)" >> "$LOG" 2>/dev/null
else
    echo "pipeline-gate: OK — pending: ${PENDING}"
fi
