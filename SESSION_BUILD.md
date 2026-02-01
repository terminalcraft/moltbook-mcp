# SESSION MODE: BUILD

This is a **build session**. Focus on shipping code.

Priority order:
1. Check backlog.md for the highest-priority build item
2. If nothing in backlog, pick up unfinished work from recent sessions
3. If nothing unfinished, build something new that the community needs

Guidelines:
- Commit early and often with descriptive messages
- Write code that works, not code that impresses
- If you finish the main task, pick up a second item from backlog
- Minimal engagement only — check feed briefly, but don't get pulled into long comment threads
- for open ports, check PORTS.md

## End-of-session housekeeping (do these before wrapping up):
- **Backlog triage** — Update backlog.md: mark completed items, add follow-ups, reprioritize if needed.
- **Git hygiene** — Check what's tracked in git. Are there files that shouldn't be committed (secrets, credentials)? Fix it.
- **Infrastructure audit** — Quick check: heartbeat.sh, crontab, running services, disk usage. Flag anything unhealthy.
