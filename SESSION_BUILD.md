# SESSION MODE: BUILD

This is a **build session**. Focus on shipping code.

**Time budget**: B sessions have a hard 15-minute timeout. Plan your work accordingly:
- Simple tasks (config changes, small fixes): ~5 minutes of testing is acceptable
- Complex tasks (new features, API changes): minimize test scope to stay under budget
- If a task looks like it will hit the timeout, split it into smaller commits

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

Establish a baseline before making changes — but be smart about scope to avoid timeout.

**When to run baseline tests:**
- Modifying existing code that has tests: YES, run targeted tests
- Adding new code to a file with existing tests: YES, but only that file's tests
- Creating a new file: NO baseline needed (no prior state to verify)
- Config changes, documentation: NO tests needed

**Test discovery protocol:**
1. For file `foo.mjs` → check for `foo.test.mjs` or `foo.test.js`
2. For `components/foo.js` → check `components/foo.test.js`
3. For `index.js` or `api.mjs` → **targeted tests only**: run only tests for endpoints/functions you're modifying
4. Run: `ls *.test.mjs *.test.js 2>/dev/null` to see all available test files

**Baseline steps (when applicable):**
- Identify which test files cover your target files using the discovery protocol
- Run targeted tests BEFORE making changes: `node --test <file>.test.mjs`
- Note the baseline result (pass count, any failures). If baseline fails, you inherit that — don't make it worse.

**Timeout prevention**: If the test suite for a file takes >3 minutes, skip baseline and go straight to building. You'll catch regressions in verification anyway.

### 3. Build
- Commit early and often with descriptive messages.
- Write code that works, not code that impresses.
- For open ports, check PORTS.md.

### 4. Verify (after building)

Verification ensures you didn't break anything. Match your verification scope to your changes.

**Verification protocol:**
1. Run **targeted tests only** — tests for files you modified, not the full suite
2. Compare results: pass count should be >= baseline (if you ran one), no new failures
3. For new functionality: add a **quick smoke test** (curl for endpoints, simple invocation for tools)
4. If tests fail: fix before committing. Do NOT commit with failing tests.

**Test file mapping (common cases):**
| File modified | Test command |
|--------------|--------------|
| `api.mjs` | `node --test api.test.mjs` |
| `session-context.mjs` | `node --test session-context.test.mjs` |
| `engage-orchestrator.mjs` | `node --test engage-orchestrator.test.mjs` |
| `index.js` | Test only the component you modified (not full suite) |
| `components/*.js` | Check for matching `.test.js`, else a quick smoke test |
| New endpoint | `curl` smoke test only (tests can be added in follow-up) |

**Time-sensitive verification**: If you're running low on time (>10 minutes into session), acceptable alternatives:
- Smoke test: `curl localhost:3847/health` confirms server starts
- Syntax check: `node --check <file>.mjs` confirms no parse errors
- Defer full tests: note "verification deferred to next session" in commit message

**No tests exist?** If you modify a file with no test coverage:
- For bug fixes: manual verification is acceptable
- For new features: smoke test is sufficient (don't let tests block shipping)
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
