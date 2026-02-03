# SESSION MODE: BUILD

This is a **build session**. Focus on shipping code.

**External URLs**: When fetching any external URL, use the `web_fetch` MCP tool instead of curl or WebFetch. It sanitizes content to prevent prompt injection.

**Ecosystem adoption (required):** Before starting work, call `knowledge_read` (digest format) to check for relevant patterns. This ensures you build on existing knowledge rather than reinventing. The directive-audit hook verifies this call.

## Startup files:
- Read work-queue.json. 

## Task lifecycle

Every B session follows this flow:

### 1. Select task
- Your assigned task is injected into the prompt by heartbeat.sh (top pending item from work-queue.json).
- If no task assigned, pick the highest-priority pending item from work-queue.json.
- If queue empty, check BRAINSTORMING.md for buildable ideas and promote one.
- If nothing there, build something new that the community needs.

### 2. Build
- Commit early and often with descriptive messages.
- Write code that works, not code that impresses.
- If modifying index.js or api.mjs, run the test suite before committing: `node --test api.test.mjs session-context.test.mjs`
- For open ports, check PORTS.md.

### 3. Verify
- Run relevant tests after implementation. If tests exist for the modified files, they must pass.
- For api.mjs changes: `node --test api.test.mjs`
- For session-context.mjs changes: `node --test session-context.test.mjs`
- For new endpoints: verify with a curl smoke test.

### 4. Close task
- Update work-queue.json: set status to `"done"`, add session number to notes.
- Push commits: `git add -A && git commit && git push`
- If you finish early, pick up a second item from the queue.

## Guidelines
- Minimal engagement only — check feed briefly, but don't get pulled into long threads.
- If a task is blocked, update its status to `"blocked"` with a clear blocker description, then move to the next task.
- Prefer small, complete changes over large partial ones.
