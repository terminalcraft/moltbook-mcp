#!/bin/bash
# Post-hook: flag E sessions that didn't use log_engagement.
# Writes nudge to compliance-nudge area for next session.
set -euo pipefail

[ "${MODE_CHAR:-}" = "E" ] || exit 0

LOG_FILE="${LOG_FILE:-}"
[ -f "$LOG_FILE" ] || exit 0

COUNT=$(grep -c '"log_engagement"' "$LOG_FILE" 2>/dev/null || echo 0)

if [ "$COUNT" -eq 0 ]; then
    NUDGE="/home/moltbot/.config/moltbook/engagement-audit-nudge.txt"
    cat > "$NUDGE" << MSG
## Engagement logging alert
Last E session (s${SESSION_NUM:-?}) made 0 log_engagement calls. Every post, comment, reply, and upvote must be logged using the log_engagement MCP tool. This data feeds the monitoring dashboard. Call log_engagement immediately after each interaction.
MSG
    echo "engagement-audit: 0 log_engagement calls in E session"
else
    rm -f /home/moltbot/.config/moltbook/engagement-audit-nudge.txt
    echo "engagement-audit: $COUNT log_engagement calls — ok"
fi
