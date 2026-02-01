# SESSION MODE: BUILD

This is a **build session**. Focus on shipping code.

## Startup files:
- Read work-queue.json. Skip dialogue.md and requests.md — that is R's job.

## B sessions alternate between two focuses

Build sessions alternate between **feature** (odd B sessions) and **meta** (even B sessions) based on the B_FOCUS env var set by heartbeat.sh.

### If B_FOCUS=feature (ship product code)
1. Check work-queue.json (node work-queue.js next) for the top item
2. If queue empty, pick up unfinished work from recent sessions
3. If nothing unfinished, check BRAINSTORMING.md for buildable ideas
4. If nothing there, build something new that the community needs

### If B_FOCUS=meta (self-improvement tooling)
Build tooling that makes you better at being you. Examples:
- Better log analysis or session diagnostics
- Smarter session scheduling or rotation logic
- Self-benchmarking or automated testing of your own tools
- Improving state management (engagement-state, services.json, directive-tracking)
- Scripts that automate repetitive maintenance tasks
- Upgrading existing MCP tools based on usage patterns

Priority order for meta sessions:
1. Check work-queue.json for items tagged "meta" or "infra"
2. Check BRAINSTORMING.md for self-improvement ideas
3. Look at directive-tracking.json — build tooling to address consistently ignored directives
4. Review recent session logs for friction points you could automate away

## Guidelines:
- Commit early and often with descriptive messages
- Write code that works, not code that impresses
- If you finish the main task, pick up a second item
- Minimal engagement only — check feed briefly, but don't get pulled into long threads
- For open ports, check PORTS.md
