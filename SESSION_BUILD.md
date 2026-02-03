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

### 2. Baseline (before building)

Establish a baseline before making changes. This catches pre-existing failures and ensures you don't break what already works.

**Test discovery protocol:**
1. For file `foo.mjs` → check for `foo.test.mjs` or `foo.test.js`
2. For `components/foo.js` → check `components/foo.test.js`
3. For `index.js` or `api.mjs` → run the full suite: `node --test *.test.mjs`
4. Run: `ls *.test.mjs *.test.js 2>/dev/null` to see all available test files

**Baseline steps:**
- Identify which test files cover your target files using the discovery protocol
- Run those tests BEFORE making changes: `node --test <file>.test.mjs`
- Note the baseline result (pass count, any failures). If baseline fails, you inherit that — don't make it worse.

### 3. Build
- Commit early and often with descriptive messages.
- Write code that works, not code that impresses.
- For open ports, check PORTS.md.

### 4. Verify (after building)

Run the same tests from your baseline. The verification must pass before you can close the task.

**Verification protocol:**
1. Run the same test command from step 2
2. Compare results: pass count should be >= baseline, no new failures
3. For new functionality: add a smoke test (curl for endpoints, simple invocation for tools)
4. If tests fail: fix before committing. Do NOT commit with failing tests.

**Test file mapping (common cases):**
| File modified | Test command |
|--------------|--------------|
| `api.mjs` | `node --test api.test.mjs` |
| `session-context.mjs` | `node --test session-context.test.mjs` |
| `engage-orchestrator.mjs` | `node --test engage-orchestrator.test.mjs` |
| `index.js` | `node --test api.test.mjs session-context.test.mjs` |
| `components/*.js` | Check for matching `.test.js`, else `node --test api.test.mjs` |
| New endpoint | `curl` smoke test + relevant test file |

**No tests exist?** If you modify a file with no test coverage:
- For bug fixes: manual verification is acceptable
- For new features: consider adding a test (but don't let it block shipping)
- Note "no tests" in the commit message so future sessions know

### 5. Close task
- Update work-queue.json: set status to `"done"`, add session number to notes.
- Push commits: `git add -A && git commit && git push`
- If you finish early, pick up a second item from the queue.

## Session Forking for Exploration

When trying a risky approach (major refactor, speculative feature), use session forking to create a safe checkpoint:

```bash
# Before starting risky work
node session-fork.mjs snapshot explore-refactor

# Try the approach...
# ...work on the risky change...

# If it works — commit the snapshot (delete it, keep current state)
node session-fork.mjs commit explore-refactor

# If it fails — restore to snapshot (discard failed changes)
node session-fork.mjs restore explore-refactor
```

**Commands:**
- `snapshot <name>` — Create checkpoint before exploration
- `restore <name>` — Revert to checkpoint (discard current changes)
- `commit <name>` — Delete checkpoint (keep current state as canonical)
- `list` — Show all active snapshots
- `status` — Check if snapshots exist

**What gets snapshotted:** work-queue.json, BRAINSTORMING.md, directives.json, services.json, human-review.json, engagement-state.json, engagement-intel.json

Snapshots older than 3 days are auto-cleaned by the pre-session hook.

## Guidelines
- Minimal engagement only — check feed briefly, but don't get pulled into long threads.
- If a task is blocked, update its status to `"blocked"` with a clear blocker description, then move to the next task.
- Prefer small, complete changes over large partial ones.
