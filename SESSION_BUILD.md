# SESSION MODE: BUILD

This is a **build session**. Focus on shipping code.

**Time budget**: B sessions have a hard 15-minute timeout. Plan accordingly:
- Simple tasks (config changes, small fixes): full test run acceptable
- Complex tasks (new features, API changes): commit frequently, defer comprehensive testing
- If a task will hit the timeout, split it — ship what's done, create follow-up work-queue item

**External URLs**: When fetching external URLs, use the `web_fetch` MCP tool instead of curl or WebFetch.

**Ecosystem adoption (required):** Before starting work, call `knowledge_read` (digest format) to check for relevant patterns. The directive-audit hook verifies this call.

## Startup files:
- Read work-queue.json.

## Task lifecycle

Every B session follows this flow:

### 1. Select task
- Your assigned task is injected into the prompt by heartbeat.sh (top pending item from work-queue.json).
- If no task assigned, pick the highest-priority pending item from work-queue.json.
- **Priority boost for audit items**: Items with `"audit"` tag should be worked before auto-seeded items.
- If queue empty, check BRAINSTORMING.md for buildable ideas and promote one.
- If nothing there, build something new that the community needs.

### 2. Baseline (before building)

Establish a baseline before making changes — but be smart about scope.

**When to run baseline tests:**
- Modifying existing code that has tests: YES, run targeted tests
- Adding new code to a file with existing tests: YES, but only that file's tests
- Creating a new file: NO baseline needed
- Config changes, documentation: NO tests needed

**Test discovery protocol:**
1. For file `foo.mjs` → check for `foo.test.mjs` or `foo.test.js`
2. For `components/foo.js` → check `components/foo.test.js`
3. For `index.js` or `api.mjs` → **targeted tests only**: run only tests for endpoints/functions you're modifying
4. Run: `ls *.test.mjs *.test.js 2>/dev/null` to see all available test files

**Baseline steps (when applicable):**
- Identify which test files cover your target files
- Run targeted tests BEFORE making changes: `node --test <file>.test.mjs`
- Note the baseline result. If baseline fails, you inherit that — don't make it worse.

**Timeout prevention**: If tests take >3 minutes, skip baseline. You'll catch regressions in verification.

### 3. Build

- **Commit early and often** with descriptive messages. Frequent small commits beat one big commit.
- Write code that works, not code that impresses.
- For open ports, check PORTS.md.

### 4. Verify (after building)

Verification ensures you didn't break anything. Match scope to your changes.

**Verification protocol:**
1. Run **targeted tests only** — tests for files you modified, not the full suite
2. Compare results: pass count >= baseline, no new failures
3. For new functionality: add a **quick smoke test** (curl for endpoints, simple invocation for tools)
4. If tests fail: fix before committing. Do NOT commit with failing tests.

**Test file mapping (common cases):**
| File modified | Test command |
|--------------|--------------|
| `api.mjs` | `node --test api.test.mjs` |
| `session-context.mjs` | `node --test session-context.test.mjs` |
| `engage-orchestrator.mjs` | `node --test engage-orchestrator.test.mjs` |
| `index.js` | Test only the component you modified |
| `components/*.js` | Check for matching `.test.js`, else smoke test |
| New endpoint | `curl` smoke test only |

**Time-sensitive verification**: If >10 minutes into session, acceptable alternatives:
- Smoke test: `curl localhost:3847/health` confirms server starts
- Syntax check: `node --check <file>.mjs` confirms no parse errors
- Defer full tests: note "verification deferred" in commit message

**No tests exist?** If you modify a file with no test coverage:
- For bug fixes: manual verification is acceptable
- For new features: smoke test is sufficient
- Note "no tests" in the commit message

### 5. Close task
- Update work-queue.json: set status to `"done"`, add session number to notes.
- Push commits: `git add -A && git commit && git push`
- If you finish early, pick up a second item from the queue.

## Session Forking for Exploration

When trying a risky approach, use session forking to create a safe checkpoint:

```bash
# Before risky work
node session-fork.mjs snapshot explore-refactor

# If it works
node session-fork.mjs commit explore-refactor

# If it fails
node session-fork.mjs restore explore-refactor
```

**Commands:**
- `snapshot <name>` — Create checkpoint before exploration
- `restore <name>` — Revert to checkpoint
- `commit <name>` — Delete checkpoint (keep current state)
- `list` — Show all active snapshots

Snapshots older than 3 days are auto-cleaned by the pre-session hook.

## Guidelines
- Minimal engagement only — don't get pulled into long threads.
- If a task is blocked, update its status to `"blocked"` with a clear blocker description, then move to the next task.
- Prefer small, complete changes over large partial ones.
