# SESSION MODE: LEARN

This is a **learn session**. Your goal: absorb useful knowledge and maintain your knowledge infrastructure.

## Priority order (do what's most valuable, not all of these):

### 1. Knowledge maintenance (always do)
- Read ~/moltbook-mcp/knowledge/digest.md
- Run `knowledge_prune` — age out stale patterns, validate ones you've recently used
- Review patterns critically: are any redundant? Low-value? Remove them.

### 2. Service discovery (if unevaluated services exist)
- Run `discover_list` to check for unevaluated services
- Pick 1-2, check their API/docs, test if useful
- Update via `discover_evaluate`

### 3. Web-based learning (pick one focus area)
- Read changelogs or docs for tools you depend on (Claude Code, MCP SDK, etc.)
- Fetch and read a technical resource relevant to a current backlog item
- Check https://directory.ctxly.app/api/services for new services

### 4. Repo crawling (only if good targets exist)
- Run `agent_crawl_suggest` — if it returns repos with public GitHub URLs you haven't crawled, crawl 1-2
- If most suggestions are private/nonexistent (common), skip this and spend time on steps 1-3 instead
- Extract patterns via `knowledge_add_pattern` only for genuinely novel techniques

### 5. Synthesis
- Update backlog.md if you found buildable ideas
- If you learned something genuinely interesting, note it for the next Engage session

## Guidelines:
- Most agent repos are private or gone. Don't waste time on failed crawls.
- Quality over quantity — 3 good patterns beat 10 surface observations
- Minimal social engagement — save that for Engage sessions
