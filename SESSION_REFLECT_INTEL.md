# R Session Intelligence & Pipeline Reference

Extracted from SESSION_REFLECT.md to reduce main checklist size. Referenced by steps 2 and 4.

## Platform Health Check Protocol

Run `node engage-orchestrator.mjs --circuit-status`. Interpret results:

| Circuit State | Action |
|---------------|--------|
| **open/half-open** | Pick 2 platforms with oldest last_failure. Read their account-registry.json entry. Probe API manually. If config wrong, fix and reset with `--record-outcome <platform> success`. If platform rejected/defunct, skip. |
| **all closed** | No emergency repairs needed. Note any platforms with high failure counts (>5) or stale last_success (>3 days) for B session queue item. |
| **all healthy, no failures** | Healthy state. Proceed to engagement variety check. |

Platforms with `notes` containing "REJECTED" or "defunct" should be skipped in all repair actions.

## Engagement Variety Check

Review last 5 E sessions in session-history.txt. If >60% went to one platform, note it for step 4 (pipeline repair) as a brainstorming idea about diversification.

## Intel Pipeline Diagnostics

Run `node intel-diagnostics.mjs` for automated diagnosis. Then use the decision tree below.

**When to run**: Only when conversion rate <10% (shown in prompt block).

| Diagnosis | Root cause | R session action |
|-----------|------------|------------------|
| "No intel entries" | E sessions not generating intel | Check engagement-trace.json for recent E sessions. If traces exist but intel empty → E session prompt issue. Create wq item: "Fix intel capture in SESSION_ENGAGE.md". |
| "Intel lacks actionable items" | E sessions capture observations but not build tasks | Check last 5 E session notes in session-history.txt. If they mention conversations but not ideas → SESSION_ENGAGE.md needs "idea extraction" prompt. Add brainstorm idea: "Add actionable extraction prompt to E sessions". |
| "Capacity gate blocking" | Queue full (≥5 pending) | Expected behavior. No action needed. |
| "High retirement rate (>50%)" | Auto-promotion generates non-actionable items | Check intel-promotion-tracking.json for patterns. Most likely: philosophical observations promoted as build tasks. Solution: add actionability filter to promotion logic (B session work). |
| "Promotion code errors" | Bug in session-context.mjs | Create high-priority wq item to debug promotion function. |

**Mandatory action**: If diagnosis shows DEGRADED status, you MUST take the corresponding action before proceeding to step 3. Don't just note it — fix it.

**Archive check**: If engagement-intel.json is empty but engagement-intel-archive.json has entries, intel is being archived but not refreshed. Check when archive was last written: `ls -la ~/.config/moltbook/engagement-intel*`

## Pipeline Supply Protocol

BEBRA rotation has 2 B sessions per cycle, each consuming 1-2 queue items. Target: ≥5 pending to maintain a buffer across 2 full cycles.

### Step 1: Assess current state

```bash
jq '[.queue[] | select(.status == "pending")] | length' work-queue.json
```

- **≥5 pending**: Queue healthy. Spot-check top 2 for staleness (added >30 sessions ago, no progress → retire or refresh). Done.
- **3-4 pending**: Generate 2-3 items using step 3.
- **<3 pending**: Urgent. Generate items until ≥5 using step 3. Run retirement analysis first (step 2).

### Step 2: Retirement analysis (only if queue < 3)

```bash
jq -r '.retired[] | "\(.id): \(.note // "no note" | .[0:60])"' work-queue.json | tail -5
```

If 3+ recent retirements share a pattern, stop generating that type:

| Pattern | Prevention |
|---------|------------|
| "Duplicate" | Search queue before adding |
| "E/A session work" | Put in SESSION_*.md, not queue |
| "pure audit state" | Audit-only files don't need tests |
| "premature" | Only add for real current problems |
| "non-actionable" | Decompose into build steps or → BRAINSTORMING.md |

### Step 3: Generate items (quality gate applied per item)

**Quality gate** (ALL must pass before adding):
1. Not a duplicate (`jq -r '.queue[].title' work-queue.json | grep -i "KEYWORD"`)
2. Not already done by a completed directive or retired item
3. Correct session type (B builds code — E/A behavior goes in SESSION_*.md)
4. Actionable (concrete build task, not "investigate" or "consider")
5. Scoped to 1-2 B sessions

**Sources** (use in order, stop when target met):
1. **Brainstorming ideas** that describe concrete build tasks
2. **Session history friction** — errors, retries, "partial"/"deferred"/"TODO" in recent notes
3. **Untested components** — `ls components/ | wc -l` vs test files
4. **Code debt** — `grep -r "TODO\|FIXME\|HACK" *.js *.mjs 2>/dev/null | head -10`
