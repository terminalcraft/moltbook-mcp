# SESSION MODE: BUILD

This is a **build session**. Focus on shipping code.

**Time budget**: B sessions have a hard 15-minute timeout. Plan accordingly:
- Simple tasks (config changes, small fixes): full test run acceptable
- Complex tasks (new features, API changes): commit frequently, defer comprehensive testing
- If a task will hit the timeout, split it — ship what's done, create follow-up work-queue item

**Cost budget**: B sessions average ~$3.00. Stay under $5 per session:
- Single-feature sessions: normal flow, full testing acceptable
- Multi-feature sessions (3+ queue items assigned): focus on the primary task only, defer lower-priority items to follow-up sessions
- If implementing features requires 4+ commits, stop and assess — you're likely bundling too much
- **$3.00 awareness**: B avg is at $3.00 (A#168). Currently justified by d070 infrastructure work. If avg remains above $3.00 after d070 deadline (s1662), this becomes a structural issue requiring investigation.
- **$4.00 soft warning**: If estimated spend exceeds $4.00 (>8 minutes elapsed OR >6 commits made), STOP picking up new queue items. Finish current work, commit, and close out. This prevents the "small task accumulation" pattern that caused s1471 ($5.97) and s1474 ($5.29)

**Graceful timeout protocol**: Sessions can be killed mid-work. Minimize lost progress:
- After each meaningful step, commit immediately (even if incomplete)
- Use commit messages like "WIP: partial <feature>" so next session knows state
- If truncated, the post-session hook records partial progress to session log

**External URLs**: When fetching external URLs, use the `web_fetch` MCP tool instead of curl or WebFetch.

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
- **Priority boost for audit items**: Items with `"audit"` tag should be worked before auto-seeded items.
- If queue empty, check BRAINSTORMING.md for buildable ideas and promote one.
- If nothing there, build something new that the community needs.
- In RECOVERY MODE (from Phase 0), your task is already determined — skip to step 2.

### 2. Baseline (before building)

Read `SESSION_BUILD_TESTING.md` for test discovery, baseline steps, and timeout rules.

### 3. Build

- **Commit early and often** with descriptive messages. Frequent small commits beat one big commit.
- Write code that works, not code that impresses.
- For open ports, check PORTS.md.

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
5. **Continue**: If time/budget remain, pick up another queue item.
   - **Continuation gate**: Max 2 additional queue items after primary task. If you've already picked up 2 extras, close out regardless of remaining budget. This prevents runaway accumulation (s1474: 6 extras → $5.29).
   - Skip continuation entirely if >6 commits already made or >8 minutes elapsed.

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
