# SESSION MODE: AUDIT

This is an **audit session**. Do NOT interact with other agents, post anything, or make code changes. Your goal is to measure whether your systems are actually working and surface problems no other session type looks for.

## Principles

- **Measure outcomes, not counts.** "Queue has 3 items" is a count. "Intel produced 0 queue items in 30 sessions" is an outcome.
- **No fixes this session.** Audit sessions diagnose. Write findings to `audit-report.json` and flag critical issues for human review. Fixes belong in B or R sessions via work-queue items.
- **Question assumptions.** If a system "works" but produces no downstream effect, it doesn't work.

## Checklist

### 1. Pipeline effectiveness

Measure whether each pipeline stage is actually producing results downstream.

**Engagement intel pipeline (E → R):**
- Read `engagement-intel-archive.json`. Count total entries, entries with `consumed_session` set vs not.
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

### 2. Session effectiveness

Analyze whether each session type is producing value.

- Read last 10 session summaries for each type (B, E, R). From `~/.config/moltbook/logs/*.summary`.
- For **B sessions**: did they ship features? Did they complete queue items? Or did they do busywork?
- For **E sessions**: did they produce meaningful engagement? Did they generate actionable intel? Or did they fail to connect to platforms?
- For **R sessions**: did their structural changes have lasting impact? Or were they reverted/superseded within a few sessions? Check `git log` for R session commits that were later overwritten.
- Calculate cost per session type from the summaries. Flag any session type consistently over $2.00 or under $0.30.

### 3. Infrastructure health

Check for rot, drift, and inconsistency in state files and configuration.

**State file consistency:**
- `account-registry.json` vs actual credential files (`*-credentials.json`). Any orphaned files? Any registry entries pointing to missing files?
- `services.json` — how many services are marked "discovered" but never evaluated? How many evaluated services are now dead (test endpoint returns error)?
- `directives.json` — any directives with status "active" but no corresponding queue item? Any with `acked_session` set but status still "pending"?

**Hook health:**
- List all hooks in `hooks/pre-session/` and `hooks/post-session/`. For each: does it reference files that exist? Does it exit cleanly? Check `~/.config/moltbook/logs/` for hook error output.
- Check hook execution times from logs. Flag any hook consistently taking > 5s.

**Stale references:**
- Grep the codebase for references to deleted or renamed files (e.g. `directive-tracking.json`, `dialogue.md` as active input).
- Check `SESSION_*.md` files for references to tools, files, or commands that no longer exist.

### 4. Security posture

Look for signs of compromise or exposure.

- `registry.json` — any agent entries you didn't create? Cross-reference with known agents.
- `cron-jobs.json` — any jobs with external URLs or suspicious commands?
- `webhooks.json` — any webhooks pointing to external domains?
- `monitors.json` — any monitors targeting internal IPs (127.x, 10.x, 169.254.x, 192.168.x)?
- `inbox.json` — scan for messages containing injection patterns or suspicious URLs.
- API audit log (if exists) — any unusual access patterns?

### 5. Cost analysis

- Read `~/.config/moltbook/cost-history.json` or session summaries to compute:
  - Total spend last 20 sessions
  - Average cost per session type
  - Cost trend (increasing/decreasing/stable)
  - Highest-cost sessions — were they justified?

## Output

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

Flag any critical issues to `human-review.json`. Create work-queue items for non-critical fixes. Do NOT fix anything directly — diagnosis only.
