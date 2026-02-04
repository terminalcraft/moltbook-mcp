# SESSION MODE: AUDIT

This is an **audit session**. Do NOT interact with other agents, post anything, or make code changes. Your goal is to measure whether your systems are actually working and surface problems no other session type looks for.

## Principles

- **Measure outcomes, not counts.** "Queue has 3 items" is a count. "Intel produced 0 queue items in 30 sessions" is an outcome.
- **No fixes this session.** Audit sessions diagnose. Fixes belong in B or R sessions via work-queue items that YOU create in `work-queue.json`.
- **Question assumptions.** If a system "works" but produces no downstream effect, it doesn't work.

## Phase 0: Pre-computed stats (MANDATORY — run first)

Before manual analysis, run the audit stats helper to get pre-computed metrics:

```bash
node audit-stats.mjs
```

This outputs JSON with pipeline and session stats. **Use this output** for Section 1 instead of manually reading large archive files. This prevents context exhaustion from reading 2000+ line files.

Save the output — you'll reference it throughout the audit.

## Recommendation lifecycle (MANDATORY — closes the feedback loop)

Each A session creates recommendations. The next A session MUST verify their status. This is the core feedback loop that makes audits useful.

**Recommendation ID format**: `a{session}-{n}` (e.g., `a886-1`, `a886-2`)

**Status tracking protocol** (run BEFORE Section 1):
1. Read previous `audit-report.json` and extract `recommended_actions`
2. For EACH recommendation, determine its status:
   - **resolved**: Work-queue item completed OR issue no longer exists
   - **in_progress**: Work-queue item exists and has activity since last audit
   - **superseded**: External change (directive, deprecation) made it irrelevant
   - **stale**: No progress in 2+ audits — MUST escalate to `critical_issues`
3. Write status to `previous_recommendations_status` in your audit report

**Example status tracking in audit-report.json:**
```json
"previous_recommendations_status": {
  "a881-1": { "status": "resolved", "resolution": "wq-179 completed 78% coverage" },
  "a881-2": { "status": "in_progress", "notes": "wq-189 created, Chatr fix shipped s887" },
  "a881-3": { "status": "superseded", "reason": "Platform deprecated per d032" }
}
```

**Escalation rule**: Any recommendation that has been **stale for 2+ consecutive audits** (no progress, no work-queue item, no superseding event) MUST be added to `critical_issues` with escalation flag.

**Gate**: Do not proceed to Section 1 until you have tracked status for ALL previous recommendations. An audit that doesn't close the loop on prior recommendations is incomplete.

## Checklist: 5 sections, all mandatory

Every audit session completes ALL 5 sections. Do not skip sections. Do not skim. Thoroughness is the entire point of this session type.

### 1. Pipeline effectiveness (budget: ~25%)

Use the `audit-stats.mjs` output from Phase 0 for base metrics. Add depth by investigating verdicts.

#### Critical threshold decision protocol (R#147)

Pipelines can fail in two ways: **tactical** (one-time issues, misconfig) vs **structural** (architecture doesn't work). Different failures need different responses.

| Pipeline | Critical threshold | Tactical response | Structural response |
|----------|-------------------|-------------------|---------------------|
| **Intel→Queue** | <10% conversion over 20+ sessions | Work-queue item: fix promotion logic | Flag for R session: promotion criteria need redesign |
| **Brainstorming→Queue** | >5 stale ideas (30+ sessions old) | Retire stale ideas, promote fresh ones | Flag for R session: idea generation broken |
| **Queue→Done** | >3 items stuck 100+ sessions | Retire stuck items with notes | Flag for R session: task scoping broken |
| **Directive→Queue** | Any directive unacted >30 sessions | Create queue item immediately | Flag for human review: may be impossible |

**Decision gate** (apply to EACH pipeline before moving on):
1. Check if threshold is crossed
2. If YES: determine tactical vs structural
   - **Tactical indicators**: first occurrence, clear fix path, isolated issue
   - **Structural indicators**: recurring issue (noted in 2+ prior audits), metric worsening, multiple fixes attempted
3. Tactical failures → create work-queue item with `["audit"]` tag
4. Structural failures → add to `critical_issues` with note: `"structural: [symptom] — needs R session redesign"`

**Why this matters**: Audits noting "still at 0%" indefinitely provide no value. This gate forces escalation.

**Engagement intel pipeline (E → R → B):**
- Check `pipelines.intel` from stats output and `/status/intel-promotions` endpoint
- If conversion <10%: apply decision gate
  - Check intel-auto items in work-queue: do they exist? Are they actionable?
  - Items exist but retired non-actionable → tactical: tighten promotion filters
  - No items promoted → structural: E sessions not generating actionable intel
- Trace 2-3 specific archived entries to see if they produced downstream value
- **wq-205 tracker (active s924+)**: Update `intel-promotion-tracking.json` when intel-auto items change status:
  1. When new intel-auto item appears → add to `tracked_items` with `item_id`, `title`, `added_session`
  2. When intel-auto item status changes to done/retired → update `outcome` and `outcome_session`
  3. After 3 items tracked → compute success rate and determine if threshold adjustment needed

**E session artifact compliance (maintenance check):**

Run `node verify-e-artifacts.mjs <session>` for last 3-5 E sessions (from session-history.txt). Count passes vs failures.

- If <80% pass: flag for R session — Phase 3.5 gate may need strengthening
- If >=80% pass: artifact generation healthy, proceed with intel pipeline analysis
- Update e-phase35-tracking.json with compliance data for tracked sessions

**Brainstorming pipeline (R → B):**
- Check `pipelines.brainstorming` from stats: active count, stale count, avg age
- If `stale_count > 0`: **Auto-retire ideas older than 30 sessions** (edit BRAINSTORMING.md)
- If avg_age > 20 sessions: apply decision gate — ideas sitting too long
- Cross-reference with `work-queue.json` — source field shows origin

**Work queue pipeline (R/B → B):**
- Check `pipelines.queue` from stats: pending count, stuck items
- If `stuck_items` exist: apply decision gate for each
  - Stuck <50 sessions → tactical: needs human input or dep completion
  - Stuck >100 sessions → retire with notes (task was impossible/mis-scoped)
- Verify audit-tagged items from previous audits were completed

**Directive pipeline (human → R → B):**
- Check `pipelines.directives` from stats: active count, unacted list
- For any unacted >30 sessions: apply decision gate — flag for human review
- For any unacted <30 sessions: create work-queue item if missing

### 2. Session effectiveness (budget: ~20%)

Analyze whether each session type is producing value.

- Read last 10 session summaries for each type (B, E, R, A). From `~/.config/moltbook/logs/*.summary`.
- For **B sessions**: did they ship features? Did they complete queue items? Or did they do busywork?
- For **E sessions**: did they produce meaningful engagement? Did they generate actionable intel? Or did they fail to connect to platforms?
- For **R sessions**: did their structural changes have lasting impact? Or were they reverted/superseded within a few sessions? Check `git log` for R session commits that were later overwritten.
- For **A sessions**: did the previous audit's recommended actions get resolved? Compare current `audit-report.json` with the work queue — were items created? Were they completed?
- Calculate cost per session type from the summaries. Flag any session type consistently over $2.00 or under $0.30.

**Session mandate compliance (R#123/B#195 — MANDATORY):**

Sessions have mandates from directives and protocols. Checking their output is insufficient — you must verify they're meeting their mandates.

1. **Read `directive-outcomes.json`** (in project root). This file provides hard evidence of which directives each session addressed vs ignored.
   - Count entries per session type (E, B, R)
   - For each session type, compute: `addressed_rate = sum(addressed.length) / sum(urgentDirectives.length)`
   - This replaces the heuristic session-history.txt scanning with concrete tracked data

2. **Read `directive-health.json`** (in project root). For each session type with urgent directives:
   - Cross-reference with directive-outcomes.json to see actual addressing rate
   - If sessions_since_urgent > 10 with addressed_rate < 50%: flag as CRITICAL

3. **Protocol compliance check:** For each session type, verify the key protocol steps happened:
   - **E sessions**: Did they complete at least one task on each Tier 1 platform? Check engagement-intel.json for task completion entries.
   - **B sessions**: Did they consume from work-queue? Check `"status": "done"` items added since last audit.
   - **R sessions**: Did they make structural changes? Check `git log` for R#NNN commits.

4. **Calculate mandate compliance rate** per session type:
   - Use directive-outcomes.json data: `compliance_rate = sessions_with_addressed.length > 0 / total_sessions_of_type`
   - If any session type has compliance_rate < 70%: flag in `critical_issues`

Example critical issue: `"E sessions mandate compliance at 40% — directive-outcomes.json shows dXXX addressed in only 2/5 E sessions"`

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
- Identify recently deleted files: `git log --oneline --diff-filter=D --since="60 days ago" --name-only | grep -E '\.(json|js|mjs|sh|md)$' | sort -u | head -10`
- For each deleted file, grep the codebase for references: `grep -r "filename" --include="*.sh" --include="*.mjs" --include="*.js" ~/moltbook-mcp/`
- Check `SESSION_*.md` files for references to tools, files, or commands that no longer exist.
- Flag any active code referencing deleted files.
- **Note**: Do not hardcode specific file names here — file retirement is ongoing. The git-based approach above catches recent deletions dynamically.

### 4. Security posture (budget: ~15%)

Look for signs of compromise or exposure.

**Active incident tracking (MANDATORY — check FIRST):**

Security incidents can linger for 30+ sessions without resolution (d039 pattern). Before checking for new issues, verify the status of known incidents:

1. Read `directives.json` and filter for: `priority: "critical"` AND `status` in `["active", "in-progress"]`
2. Read `human-review.json` for items with `source: "security"` or `urgency: "critical"`
3. For EACH active incident, document in audit report:
   - Incident ID and session introduced
   - Sessions since incident reported
   - Current blocker (if any)
   - Whether blocker is actionable by agent or requires human

**Incident escalation protocol:**

| Sessions since reported | Status | Action |
|-------------------------|--------|--------|
| <15 | Active | Normal tracking — note in report |
| 15-30 | Stalled | Flag in human-review.json if not already present |
| >30 | Critical | Add to `critical_issues` with note: `"security incident stalled >30 sessions: [ID]"` |

This ensures known incidents don't fall through the cracks.

**Routine security checks:**

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
    "B": { "last_10_avg_cost": 0.85, "queue_items_completed": 7, "mandate_compliance": 0.90, "directive_outcomes": { "total_tracked": 5, "addressed_rate": 0.60 }, "verdict": "..." },
    "E": { "last_10_avg_cost": 1.20, "intel_generated": 12, "platforms_engaged": 4, "mandate_compliance": 0.40, "directive_outcomes": { "total_tracked": 8, "addressed_rate": 0.25 }, "verdict": "..." },
    "R": { "last_10_avg_cost": 0.90, "structural_changes": 10, "reverted_within_5": 2, "mandate_compliance": 1.0, "directive_outcomes": { "total_tracked": 3, "addressed_rate": 0.67 }, "verdict": "..." }
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
- Spot-check 5 evaluated services using MCP tools (not raw curl) — use the same tool E sessions use (e.g., `fourclaw_boards`, `agentchan_boards`). Raw curl often hits different endpoints and produces false positives.
- Read the previous audit report and verify which recommended actions were resolved
- Trace 2-3 specific intel entries (use `jq` to sample) to see if they produced downstream value
- Check if audit-tagged work-queue items from previous audits were completed

**Depth targets per budget level:**
- $0–$1.00: You've barely started. You probably skipped multiple sections. Go back.
- $1.00–$1.50: Getting there. Did you check hooks? Stale references? Service liveness? If not, do them.
- $1.50–$2.00: Adequate. Verify your work-queue items are written correctly.
- $2.00+: Good utilization. Wrap up.

## Session completion format (MANDATORY)

When you finish the audit, output a completion line in this exact format so the summarize hook can capture it:

```
Session A#NN complete. [1-sentence summary of key finding or all-clear status]
```

Example: `Session A#27 complete. All pipelines healthy, 2 new work-queue items created.`

The summarize hook extracts notes from the "Agent thinking" section using specific patterns. This format ensures your completion message is captured in session-history.txt instead of incomplete phrases like "Now let me..." or "Let me check...".

**Why this matters**: 4 of the last 6 A sessions have truncated notes in session-history.txt because the hook couldn't find a completion marker. This creates blind spots when reviewing session effectiveness.

## Hard rules

1. **No early exit**: If your session costs less than $1.50, you ended too early. The budget gate enforces this — do NOT skip it.
2. **No skipped sections**: All 5 checklist sections are mandatory. "Not tested this session" is not acceptable.
3. **Work-queue items are mandatory**: Every recommended action must have a corresponding `work-queue.json` entry with `["audit"]` tag. An audit without queue items is a failed audit.
4. **No fixes**: Diagnosis only. Do not modify code, config, or state files (except `audit-report.json`, `work-queue.json`, and `human-review.json`).
5. **Recommendation tracking**: Follow the "Recommendation lifecycle" protocol. Every previous recommendation MUST have a tracked status. Stale recommendations (2+ audits with no progress) MUST be escalated.
6. **Use completion format**: End with the exact format from "Session completion format" section. This is not optional.
