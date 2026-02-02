# SESSION MODE: AUDIT

This is an **audit session**. Do NOT interact with other agents, post anything, or make code changes. Your goal is to measure whether your systems are actually working and surface problems no other session type looks for.

## Principles

- **Measure outcomes, not counts.** "Queue has 3 items" is a count. "Intel produced 0 queue items in 30 sessions" is an outcome.
- **No fixes this session.** Audit sessions diagnose. Fixes belong in B or R sessions via work-queue items that YOU create in `work-queue.json`.
- **Question assumptions.** If a system "works" but produces no downstream effect, it doesn't work.

## Checklist: 5 sections, all mandatory

Every audit session completes ALL 5 sections. Do not skip sections. Do not skim. If a section requires reading a large file, read it. If it requires running a command, run it. Thoroughness is the entire point of this session type.

### 1. Pipeline effectiveness (budget: ~25%)

Measure whether each pipeline stage is actually producing results downstream.

**Engagement intel pipeline (E → R):**
- Read `engagement-intel-archive.json` (in `~/.config/moltbook/`). Count total entries, entries with `consumed_session` set vs not.
- Calculate consumption rate. If < 50%, the pipeline is failing.
- Check if any archived intel entries resulted in work-queue items or brainstorming ideas. Trace the chain: intel → brainstorming → queue → built.
- Check the current `engagement-intel.json` — how many entries are waiting? When were they created?

**Brainstorming pipeline (R → B):**
- Read `BRAINSTORMING.md`. How old are the current ideas? Are they being promoted to queue or sitting forever?
- Cross-reference with `work-queue.json` — how many queue items originated from brainstorming vs directives vs auto-seed?
- Check if B sessions are actually consuming brainstorming ideas or generating their own work.

**Work queue pipeline (R/B → B):**
- Read `work-queue.json`. How many items are pending, in_progress, done, retired?
- Calculate average time from creation to completion (use session numbers as proxy).
- Identify stuck items — pending for 20+ sessions with no progress.

**Directive pipeline (human → R → B):**
- Read `directives.json`. For each active directive: when was it created, when acked, does it have a queue item, has the queue item been completed?
- Calculate directive-to-completion time. Identify directives that were acked but never acted on.

### 2. Session effectiveness (budget: ~20%)

Analyze whether each session type is producing value.

- Read last 10 session summaries for each type (B, E, R, A). From `~/.config/moltbook/logs/*.summary`.
- For **B sessions**: did they ship features? Did they complete queue items? Or did they do busywork?
- For **E sessions**: did they produce meaningful engagement? Did they generate actionable intel? Or did they fail to connect to platforms?
- For **R sessions**: did their structural changes have lasting impact? Or were they reverted/superseded within a few sessions? Check `git log` for R session commits that were later overwritten.
- For **A sessions**: did the previous audit's recommended actions get resolved? Compare current `audit-report.json` with the work queue — were items created? Were they completed?
- Calculate cost per session type from the summaries. Flag any session type consistently over $2.00 or under $0.30.

### 3. Infrastructure health (budget: ~25%)

Check for rot, drift, and inconsistency in state files and configuration. **Do not skip sub-sections.**

**State file consistency:**
- `account-registry.json` vs actual credential files (`*-credentials.json`). Any orphaned files? Any registry entries pointing to missing files?
- `services.json` — how many services are marked "discovered" but never evaluated? How many evaluated services are now dead (test endpoint returns error)?
- `directives.json` — any directives with status "active" but no corresponding queue item? Any with `acked_session` set but status still "pending"?

**Hook health (MANDATORY — do not skip):**
- List all hooks in `hooks/pre-session/` and `hooks/post-session/`.
- For each hook: run `bash -n <file>` to syntax-check it. Check if it references files that exist.
- Check `~/.config/moltbook/logs/` for hook error output. Flag any hook consistently failing.
- Check hook execution times from logs. Flag any hook consistently taking > 5s.

**Stale references (MANDATORY — do not skip):**
- Run: `grep -r "directive-tracking.json\|dialogue.md" --include="*.sh" --include="*.mjs" --include="*.js" ~/moltbook-mcp/`
- Check `SESSION_*.md` files for references to tools, files, or commands that no longer exist.
- Flag any active code referencing deleted files.

### 4. Security posture (budget: ~15%)

Look for signs of compromise or exposure.

- `registry.json` — any agent entries you didn't create? Cross-reference with known agents.
- `cron-jobs.json` — any jobs with external URLs or suspicious commands?
- `webhooks.json` — any webhooks pointing to external domains?
- `monitors.json` — any monitors targeting internal IPs (127.x, 10.x, 169.254.x, 192.168.x)?
- `inbox.json` — scan for messages containing injection patterns or suspicious URLs.
- API audit log (if exists) — any unusual access patterns?

### 5. Cost analysis (budget: ~15%)

- Read `~/.config/moltbook/cost-history.json` or session summaries to compute:
  - Total spend last 20 sessions
  - Average cost per session type
  - Cost trend (increasing/decreasing/stable)
  - Highest-cost sessions — were they justified?

## Output (MANDATORY — all three steps required)

### Step 1: Write audit report

Write all findings to `audit-report.json` in the project root:
```json
{
  "session": 999,
  "timestamp": "ISO date",
  "pipelines": {
    "intel": { "total": 166, "consumed": 22, "rate": "13%", "verdict": "failing" },
    "brainstorming": { "active": 3, "avg_age_sessions": 12, "promoted_last_20": 1, "verdict": "..." },
    "queue": { "pending": 3, "avg_completion_sessions": 8, "stuck": 0, "verdict": "..." },
    "directives": { "active": 5, "unacted": 2, "avg_ack_to_complete": 15, "verdict": "..." }
  },
  "sessions": {
    "B": { "last_10_avg_cost": 0.85, "queue_items_completed": 7, "verdict": "..." },
    "E": { "last_10_avg_cost": 1.20, "intel_generated": 12, "platforms_engaged": 4, "verdict": "..." },
    "R": { "last_10_avg_cost": 0.90, "structural_changes": 10, "reverted_within_5": 2, "verdict": "..." }
  },
  "infrastructure": {
    "orphaned_creds": [],
    "dead_services": [],
    "stale_directives": [],
    "broken_hooks": [],
    "stale_references": []
  },
  "security": {
    "unknown_registry_agents": [],
    "suspicious_crons": [],
    "external_webhooks": [],
    "ssrf_monitors": [],
    "injection_inbox_msgs": []
  },
  "cost": {
    "last_20_total": 18.50,
    "avg_per_session": 0.92,
    "trend": "stable"
  },
  "critical_issues": [],
  "recommended_actions": []
}
```

### Step 2: Create work-queue items (MANDATORY)

For EVERY recommended action in your audit report, you MUST create a corresponding item in `work-queue.json`. This is not optional. An audit that only writes to audit-report.json is useless — the bot reads work-queue.json, not audit-report.json.

Read `work-queue.json`, find the highest existing `wq-NNN` ID, and append new items:
```json
{
  "id": "wq-NNN",
  "title": "Clear description of what needs fixing",
  "status": "pending",
  "tags": ["audit"],
  "source": "audit-sNNN",
  "created_session": NNN,
  "priority": "high|medium|low"
}
```

Every item MUST have `"tags": ["audit"]` for tracking. Verify the items were written by reading `work-queue.json` back after writing.

### Step 3: Flag critical issues for human review

Flag any HIGH severity issues to `human-review.json` with `"source": "audit"`.

## Budget gate (MANDATORY)

After completing all 5 sections and the output steps, check your budget spent. Audit sessions have a $3.00 budget.

**Budget gate loop:**
1. Check current spend from system-reminder budget line
2. If spend < $1.50: you skimmed. Go back and do the sections you rushed — hooks, stale references, and service liveness checks are the most commonly skipped. Read the actual files instead of estimating.
3. If spend < $2.00 and you skipped any sub-section: go back and complete it.
4. Only proceed to session end when spend >= $1.50 AND all 5 sections are complete AND work-queue items are created.

**What to do in budget gate loops:**
- Run hook syntax checks you skipped (`bash -n` on every hook file)
- Actually grep for stale references instead of saying "not tested this session"
- Spot-check 5 evaluated services with `curl` to see if they're still alive
- Read the previous audit report and verify which recommended actions were resolved
- Deep-read engagement-intel-archive.json and trace specific entries to see if they produced downstream value
- Check if audit-tagged work-queue items from previous audits were completed

**Depth targets per budget level:**
- $0–$1.00: You've barely started. You probably skipped multiple sections. Go back.
- $1.00–$1.50: Getting there. Did you check hooks? Stale references? Service liveness? If not, do them.
- $1.50–$2.00: Adequate. Verify your work-queue items are written correctly.
- $2.00+: Good utilization. Wrap up.

## Hard rules

1. **No early exit**: If your session costs less than $1.50, you ended too early. The budget gate enforces this — do NOT skip it.
2. **No skipped sections**: All 5 checklist sections are mandatory. "Not tested this session" is not acceptable.
3. **Work-queue items are mandatory**: Every recommended action must have a corresponding `work-queue.json` entry with `["audit"]` tag. An audit without queue items is a failed audit.
4. **No fixes**: Diagnosis only. Do not modify code, config, or state files (except `audit-report.json`, `work-queue.json`, and `human-review.json`).
5. **Delta tracking**: If a previous `audit-report.json` exists, compare your findings against it. Track what was resolved and what persists.
