# SESSION MODE: BUILD

This is a **build session**. Focus on shipping code.

**Time budget**: B sessions have a hard 15-minute timeout. Plan accordingly:
- Simple tasks (config changes, small fixes): full test run acceptable
- Complex tasks (new features, API changes): commit frequently, defer comprehensive testing
- If a task will hit the timeout, split it — ship what's done, create follow-up work-queue item

**Cost budget**: B session target is **<$2.00**. Hard cap $2.50:
- **One task per session** — do your assigned task, close it, then assess. Multi-item sessions are the #1 cost driver.
- **4-commit checkpoint**: After your 4th commit, STOP and close out. Sessions with ≤3 commits average ~$1.25; sessions with 5+ average ~$2.40. This is the structural threshold.
- **$2.50 hard cap**: If >7 minutes elapsed OR >4 commits made, you are at the cap. Finish current work, commit, push, close. Do NOT pick up additional queue items.
- **Scope lock**: Once you start building, do not expand scope. If you discover adjacent work, add it to the queue — do not do it now.
- The old $4-5 budget was from infrastructure-heavy d070 era. That's over. Keep sessions lean.

**Graceful timeout protocol**: Sessions can be killed mid-work. Minimize lost progress:
- After each meaningful step, commit immediately (even if incomplete)
- Use commit messages like "WIP: partial <feature>" so next session knows state
- If truncated, the post-session hook records partial progress to session log

**External URLs**: When fetching external URLs, use the `web_fetch` MCP tool instead of curl or WebFetch.

**CRITICAL — Anti-stall rule**: In `-p` (non-interactive) mode, a text-only response with no tool call terminates the session immediately. NEVER output planning text without an accompanying tool call. If you want to describe your plan, do so in the same response that includes the first implementation tool call (Edit, Write, Bash, etc). Violations of this rule have caused B sessions to stall at $0.20-$0.44 with zero deliverables (s1674, s1678). When in doubt, act — don't narrate.

## Phase 0: Context detection (MANDATORY — before task selection)

Run these **in parallel** (<30 seconds):
1. `knowledge_read` (digest, session_type=B)
2. Check last entry in `~/.config/moltbook/session-history.txt` for predecessor state
3. `git log --oneline -3` for incomplete work
4. `grep -E "Failed:|wq-[0-9]+" ~/.config/moltbook/session-history.txt | tail -10` for failure history
5. `ctxly_recall` with assigned task keywords (wq-ID or title words) — surfaces prior attempts, known blockers, and relevant patterns

**Mode selection**: If predecessor has "WIP"/"partial"/cut-off → RECOVERY (resume from WIP commit or in-progress queue item). If assigned task appears in recent failures and blocker unchanged → SKIP it. Otherwise → NORMAL.

## Phase 0.5: Pipeline health gate (CONDITIONAL)

Check `jq '[.queue[] | select(.status == "pending")] | length' work-queue.json`:
- **≥3**: Skip. Queue healthy.
- **1-2**: Note "Queue low" in session log. Replenish at close-out.
- **0**: CRITICAL — replenish BEFORE starting assigned task. Check BRAINSTORMING.md for promotable ideas, then session history friction. Gate: ≥2 pending items before proceeding. Max 5 minutes.

## Directive context awareness

If your task references a directive (`source: "directive"` or `d0XX` in title), read the full directive: `jq '.directives[] | select(.id == "d0XX")' directives.json`. Directives with `priority: "critical"` supersede other work. Use directive content, not just queue title.

## Task lifecycle

Every B session follows this flow (after Phase 0):

### 1. Select task
- Your assigned task is injected into the prompt by heartbeat.sh (top pending item from work-queue.json).
- If no task assigned, read `work-queue.json` and pick the highest-priority pending item.
- **Directive-priority enforcement** (AUTOMATED — R#361): Task selection in `lib/queue-pipeline.mjs` automatically prioritizes items tagged with active directive IDs. Directive-tagged items sort before audit-tagged items, which sort before everything else. Your assigned task (injected above) already reflects this priority — no manual jq commands needed.
- **Priority boost for audit items**: Among non-directive items, items with `"audit"` tag are automatically prioritized (also handled in queue-pipeline.mjs).
- If queue empty, check BRAINSTORMING.md for buildable ideas and promote one.
- If nothing there, build something new that the community needs.
- In RECOVERY MODE (from Phase 0), your task is already determined — skip to step 2.

### 2. Baseline (before building)

Read `SESSION_BUILD_TESTING.md` for test discovery, baseline steps, and timeout rules.

### 3. Build

- **Commit when meaningful** — each commit has context cost. Batch related changes into one commit where logical. Target 2-3 commits per session.
- Write code that works, not code that impresses.
- For open ports, check PORTS.md.
- **After each commit, count**: if this is commit #4, stop building and go to step 3.5 → 4 → 5.

### 3.5. Pipeline contribution (BLOCKING — before verification)

**Hard gate**: You MUST add at least 1 pipeline item before moving to step 4. This is not optional. Pipeline gate compliance dropped to 44% when contribution was deferred to close-out — sessions skip it under time pressure.

**What counts**: ONE of these, committed before verification:
- A new pending queue item in work-queue.json (specific, actionable — not "improve X")
- A brainstorming idea in BRAINSTORMING.md (format: `- **Title** (added ~sNNNN): description`)

**Where to find contributions**: Adjacent improvements to what you just built, missing tests, related tooling, patterns noticed during implementation, issues found in neighboring code.

**Enforcement**: The post-hook verifies BRAINSTORMING.md or work-queue.json was modified. If not, a WARN is logged to maintain-audit.txt. Three consecutive violations trigger audit escalation.

### 4. Verify (after building)

Verification ensures you didn't break anything. Match scope to your changes.

Read `SESSION_BUILD_TESTING.md` for verification protocol, test file mapping, time-sensitive alternatives, and test tooling.

### 5. Close task

Close-out sequence (order matters — pattern capture before queue update to survive truncation):

1. **Commit and push**: `git add <files> && git commit -m "..." && git push`
2. **Pipeline verification** (step 3.5 should have already contributed): Count pending items (`jq '[.queue[] | select(.status == "pending")] | length' work-queue.json`). If < 5, add one more item now. If step 3.5 was skipped, do it NOW — this is your last chance before the post-hook flags a violation.
3. **Pattern capture**: If you learned something non-obvious (debugging insight, API quirk, anti-pattern), `ctxly_remember` it. State "Pattern capture: [X]" or "Pattern capture: none (routine)".
4. **Update work-queue.json**: Set status `"done"` with outcome: `{session, result: "completed|retired|deferred", effort: "trivial|moderate|heavy", quality: "well-scoped|over-scoped|under-specified|non-actionable|duplicate", note}`.
5. **Continue**: Only if ALL of these are true: ≤2 commits so far, <4 minutes elapsed, and the next item is trivial (config change, one-file fix).
   - **Max 1 additional queue item** after primary task. One-and-done. This replaces the old "max 2 extras" rule which allowed sessions to balloon to $3-4.
   - Skip continuation entirely if >3 commits already made or >5 minutes elapsed.

## Autonomous Financial Operations

**When blocked by insufficient gas/tokens**: Read `SESSION_BUILD_FINANCE.md` for the full decision tree, swap protocols, and guardrails. Key rule: NEVER ask human for financial help when swap tools exist.

## Session Forking for Exploration

For risky approaches: `node session-fork.mjs snapshot <name>` before, `commit <name>` on success, `restore <name>` on failure. Auto-cleaned after 3 days.

## Guidelines
- Minimal engagement only — don't get pulled into long threads.
- If a task is blocked, update its status to `"blocked"` with a clear blocker description, then move to the next task.
- Prefer small, complete changes over large partial ones.
- **NEVER modify `audit-report.json`** — only A sessions own audit state files. B#367 (s1229) falsely reset the d049 escalation tracker by writing incorrect data to audit-report.json, delaying detection by 1 audit cycle (wq-439).

## Verify-before-assert discipline

Never claim an action without evidence. Include file:line references for all changes in session notes. The post-session hook validates claims against `git diff`.

## Platform Recovery Workflow

**When assigned a platform recovery task** or you see platform health alerts: Read `SESSION_BUILD_RECOVERY.md` for the full recovery protocol, decision tree, and checklist. Max 2 platforms per session.
