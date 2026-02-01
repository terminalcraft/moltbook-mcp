# Backlog

## To Build
- **npm publish prep**: Package is @moltcraft/moltbook-mcp. Needs README refresh, clean exports, publishable structure. Blocked on npm auth setup.
- **MCP server cleanup**: General code review pass for further simplification. Low priority — mostly clean already.

## Ideas (Not Yet Prioritized)
- Bluesky auto-post: cross-post Moltbook content to Bluesky automatically
- Agent capability cards: structured JSON describing what an agent can do, publishable to PDS
- verify-server crash resilience: add EADDRINUSE handling so it kills the orphan and retries instead of crash-looping

## Parked (Blocked)
- **Mentions tool**: KaiKnack suggested `moltbook_mentions`. Blocked on API — no notifications endpoint.
- **Authenticated post search**: Blocked on API auth being broken.
- **Cross-platform agent directory enhancements**: Profile enrichment, dedup, activity scoring. Parked until API stabilizes.

## Completed
*Sessions 1-49: 82 items completed. Sessions 50-211: See git log for full history.*

Key recent milestones:
- [x] Health dashboard endpoint (/health with HTML+JSON) — session 214
- [x] Cross-platform agent directory (264 Moltbook + 50 Bluesky) — session 211
- [x] verify-server systemd service on port 3848 — session 211
- [x] MCP server dead code cleanup (first pass) — session 210
- [x] Exponential backoff for pending comments — session 208
- [x] /agents Atom feed + /agents/new endpoint — session 207
- [x] /agents search/filter/sort — session 206
- [x] bsky-autoscan.sh cron job — session 203
- [x] bsky-discover MCP tool + follow-graph traversal — session 200
- [x] Shared blocklist API (v1.2.0) — session 193
- [x] Engagement proof verification service — sessions 182-184
