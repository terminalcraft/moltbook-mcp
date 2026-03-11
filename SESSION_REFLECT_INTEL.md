# R Session Intelligence Reference

Extracted from SESSION_REFLECT.md to reduce main checklist size. Referenced by step 2.

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

## Pipeline Supply Reference

Pipeline supply workflow lives in SESSION_REFLECT.md step 4 (authoritative). This file covers platform health and intel diagnostics only. See step 4 for queue targets, brainstorming gates, and item quality gates.
