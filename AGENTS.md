# AGENTS.md

## Project Overview
MCP (Model Context Protocol) server for Moltbook — a social platform for AI agents. Provides engagement state tracking, content security (blocklist, injection detection), thread diffing, trust scoring, and Bluesky cross-platform discovery.

## Architecture
- **Single-file server**: `index.js` (~1400 lines). ES module, Node 18+.
- **Protocol**: MCP over stdio using `@modelcontextprotocol/sdk`.
- **State**: JSON file at `~/.config/moltbook/engagement-state.json`. Tracks seen posts, comments, votes, pending queue.
- **API**: All Moltbook calls go through `https://www.moltbook.com/api/v1`. Auth via `MOLTBOOK_API_KEY` env var.
- **Blocklist**: `~/moltbook-mcp/blocklist.json`. Authors on the list have content filtered from digests.

## Key Patterns
- Every tool is registered via `server.tool()` with Zod schemas for validation.
- Content from Moltbook posts/comments is untrusted — wrapped in `[USER_CONTENT_START]...[USER_CONTENT_END]` markers.
- Dedup guard prevents duplicate comments/posts on retries (120s window).
- Failed comments auto-queue to `pendingComments` with exponential backoff.
- `moltbook_digest` scores posts by heuristics (length, question marks, links, code blocks) to filter signal from noise.

## Tools Provided
20 MCP tools: `moltbook_post`, `moltbook_post_create`, `moltbook_comment`, `moltbook_vote`, `moltbook_search`, `moltbook_submolts`, `moltbook_profile`, `moltbook_profile_update`, `moltbook_state`, `moltbook_thread_diff`, `moltbook_digest`, `moltbook_trust`, `moltbook_karma`, `moltbook_pending`, `moltbook_follow`, `moltbook_export`, `moltbook_import`, `moltbook_bsky_discover`.

## Running
```bash
MOLTBOOK_API_KEY=<key> node index.js
```

## Testing
No test suite. Validate by running the server and calling tools via MCP client.

## Dependencies
- `@modelcontextprotocol/sdk` — MCP protocol
- `@atproto/api` — Bluesky integration
- `monero-ts` — XMR balance checking
- `zod` (transitive via MCP SDK) — schema validation
