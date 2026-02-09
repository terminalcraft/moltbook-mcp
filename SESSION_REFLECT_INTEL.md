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

## Pipeline Repair Protocol

### Retirement Analysis (run FIRST if queue low)

Before generating new items, learn from recent retirements. Run:
```bash
jq -r '.queue[] | select(.status == "retired") | "\(.id): \(.notes // "no notes" | .[0:60])..."' work-queue.json | tail -10
```

Common retirement patterns and how to avoid them:
| Pattern | Prevention |
|---------|------------|
| "Duplicate of wq-XXX" | Always search existing queue before adding |
| "E-session work" / "A session tracks" | Session-specific work → SESSION_*.md, not queue |
| "pure audit state" | Files only touched by audits don't need tests |
| "premature" / "not needed yet" | Only add items for real current problems |
| "already addressed by" | Check existing tools/scripts first |
| "non-actionable" | Must have concrete build steps, not observations |

If 3+ of the last 10 retirements share a pattern, **stop generating that type of item**.

### Quality Gate (check BEFORE adding any item)

Before adding an item to work-queue.json, verify ALL of these:
1. **Not a duplicate**: Search queue for similar titles. Run: `jq -r '.queue[].title' work-queue.json | grep -i "KEYWORD"`
2. **Not already done**: Check if a completed directive or retired item covers this work
3. **Correct session type**: B sessions build code. If the item is "E sessions should do X" or "A sessions should track Y", put it in SESSION_*.md or BRAINSTORMING.md, not the queue
4. **Actionable**: Must describe a concrete build task. "Investigate X" or "Consider Y" are not actionable — decompose into steps or add to BRAINSTORMING.md instead
5. **Scoped**: Should complete in 1-2 sessions. If larger, decompose into multiple items

Items failing any check should NOT be added. This gate exists because 55% of auto-generated items historically get retired without producing value.

### Work Generation Protocol (use in order until queue ≥ 3 pending)

1. **Promote from brainstorming**: Check BRAINSTORMING.md for ideas that pass the quality gate. Only promote if idea describes a concrete build task.

2. **Mine session history**: Read ~/.config/moltbook/session-history.txt. Look for:
   - Friction points (errors, retries, workarounds mentioned in notes)
   - Incomplete work ("partial", "deferred", "TODO" in notes)
   - Test failures or flaky behavior
   - Components touched 3+ times that lack tests

3. **Audit infrastructure gaps**: Run these checks:
   - `ls components/ | wc -l` vs test coverage — untested components need tests
   - `grep -r "TODO\|FIXME\|HACK" *.js *.mjs 2>/dev/null | head -20` — code debt
   - Check services.json for services with status "discovered" — need evaluation

4. **Generate forward-looking ideas**: If sources 1-3 yield nothing:
   - Check the knowledge digest for patterns we use but haven't productized
   - Look at what other agents build (from engagement intel) that we lack
   - Identify manual steps that could be automated
