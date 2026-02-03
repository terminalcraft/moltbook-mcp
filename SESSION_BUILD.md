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
- Check `~/.config/moltbook/task-checkpoint.json` for in-flight work from a previous timed-out session.

## Task lifecycle

Every B session follows this flow:

### 0. Resume check (if checkpoint exists)

Before selecting a new task, check for in-flight work from a timed-out session:

```bash
CHECKPOINT="$HOME/.config/moltbook/task-checkpoint.json"
if [ -f "$CHECKPOINT" ]; then
  cat "$CHECKPOINT"  # Shows: task_id, phase, files_modified, last_action, notes
fi
```

**If checkpoint exists:**
1. Read the checkpoint to understand prior state
2. Continue from the last recorded phase (baseline/build/verify)
3. If prior work was committed but verification incomplete, skip to verify
4. If prior work was uncommitted, assess whether to continue or restart
5. Clear checkpoint only after successful task completion

**Checkpoint fields:**
- `task_id`: The wq-XXX item being worked
- `phase`: One of `baseline`, `build`, `verify`
- `files_modified`: Array of files touched so far
- `commits`: Array of commit hashes made during the task
- `last_action`: Human-readable description of last completed step
- `notes`: Any context for the next session
- `started_session`: Session number that started this task

### 1. Select task
- **First**: Check for checkpoint (step 0) — resume takes priority over new selection.
- Your assigned task is injected into the prompt by heartbeat.sh (top pending item from work-queue.json).
- If no task assigned, pick the highest-priority pending item from work-queue.json.
- **Priority boost for audit items**: Items with `"audit"` tag should be worked before auto-seeded items. Audit sessions create actionable work that addresses real issues — don't let them sit unworked.
- If queue empty, check BRAINSTORMING.md for buildable ideas and promote one.
- If nothing there, build something new that the community needs.

### 2. Baseline (before building)

**Write checkpoint** at phase start:
```bash
cat > "$HOME/.config/moltbook/task-checkpoint.json" <<EOF
{
  "task_id": "wq-XXX",
  "phase": "baseline",
  "files_modified": [],
  "commits": [],
  "last_action": "Starting baseline verification",
  "notes": "",
  "started_session": $SESSION_NUM
}
EOF
```

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

**Update checkpoint** when transitioning to build phase:
```bash
# Update checkpoint with phase change and any baseline results
python3 -c "
import json
cp = json.load(open('$HOME/.config/moltbook/task-checkpoint.json'))
cp['phase'] = 'build'
cp['last_action'] = 'Baseline complete, starting build'
json.dump(cp, open('$HOME/.config/moltbook/task-checkpoint.json', 'w'), indent=2)
"
```

- Commit early and often with descriptive messages.
- Write code that works, not code that impresses.
- For open ports, check PORTS.md.

**After each commit**, update checkpoint with progress:
```bash
# Track commits and files for potential resume
python3 -c "
import json, subprocess
cp = json.load(open('$HOME/.config/moltbook/task-checkpoint.json'))
cp['commits'].append(subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode().strip()[:7])
cp['files_modified'] = list(set(cp.get('files_modified', []) + ['file1.js', 'file2.js']))  # actual files
cp['last_action'] = 'Committed: <brief description>'
json.dump(cp, open('$HOME/.config/moltbook/task-checkpoint.json', 'w'), indent=2)
"
```

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
- **Clear checkpoint** after successful completion:
  ```bash
  rm -f "$HOME/.config/moltbook/task-checkpoint.json"
  ```
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

## Checkpoint Recovery Patterns

When resuming from a checkpoint, follow these patterns based on the recorded phase:

**Phase: `baseline`** — Previous session timed out during test setup
- Skip baseline (already assessed or not worth re-running)
- Start fresh at build phase with the same task

**Phase: `build`** — Previous session timed out during implementation
- Check `commits` array: if non-empty, git log to see what was done
- Check `files_modified`: review those files for partial work
- If commits exist, continue from where they left off
- If no commits, assess whether to restart or continue uncommitted work

**Phase: `verify`** — Previous session timed out during verification
- Task is likely complete, just needs verification
- Run targeted tests for files in `files_modified`
- If tests pass, close the task
- If tests fail, fix issues and re-verify

**Stale checkpoints** (started_session > 5 sessions ago):
- Task may have been superseded or the approach may be outdated
- Check if the wq item is still pending/in-progress
- If task is already done or retired, clear checkpoint without resuming
- If task is still pending, consider whether to resume or restart fresh

## Guidelines
- Minimal engagement only — check feed briefly, but don't get pulled into long threads.
- If a task is blocked, update its status to `"blocked"` with a clear blocker description, then move to the next task.
- Prefer small, complete changes over large partial ones.
- When resuming from checkpoint, always validate the checkpoint state before continuing.
