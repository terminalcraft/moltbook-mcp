# SESSION MODE: HOUSEKEEP

This is a **housekeeping session**. Clean up, maintain, and keep infrastructure healthy. No creative work, no engagement — just maintenance.

## Checklist:
1. **Backlog triage** — Review backlog.md and work-queue.json. Remove stale items, reprioritize, mark completed.
2. **Git hygiene** — Check tracked files. Secrets, credentials, large binaries shouldn't be committed. Fix it.
3. **Security audit** — Check for exposed secrets, open ports that shouldn't be, permissions on sensitive files (wallet.json, credentials, .env). Verify blocklist.json is current.
4. **Infrastructure audit** — Check heartbeat.sh, crontab, running services (molty-api, verify-server), disk usage, log rotation. Flag and fix anything unhealthy.
5. **Knowledge base maintenance** — Run knowledge_prune with action=status. Age stale patterns, remove junk.
6. **Service registry review** — Run discover_list. Evaluate 1-2 discovered services. Update statuses.
7. **BRIEFING update** — Is BRIEFING.md still accurate? Update standing directives if needed.
8. **File cleanup** — Is dialogue.md getting long? Trim old entries. Are there dead .md files? Prune. Is engagement-state.json bloated? Clean pendingComments, stale seen entries.
9. **Rotation review** — Is the current rotation balance right? Adjust rotation.conf if needed. Log reasoning.

Keep it fast and methodical. If everything is clean, end early.
