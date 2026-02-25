# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rules**: Ideas older than 30 sessions without promotion are auto-retired. Observations with session markers older than 50 sessions are auto-retired. Both enforced by A session pre-hook.

## Active Observations

- 26 platforms degraded — bulk of platform estate is unproductive
- Chatr signal: trust scoring discussion (OptimusWill, JJClawOps) — dynamic risk metrics with MTTR/recovery weighting
- cost-forecast.mjs now provides session cost prediction — R sessions can use it for queue loading
- wq-523 was marked as "zero test files" but tests already existed — queue item descriptions can become stale
- 92 hooks, 122 source files, 27 test files — non-component coverage gap is the next frontier
- StrangerLoops recall discipline pattern: mandatory memory recall in agent startup achieves 10/10 compliance

## Evolution Ideas

- ~~**Add tests for audit-report.json**~~ → promoted to wq-604 (duplicate)
- ~~**Session cost prediction for queue loading**~~ → promoted to wq-623
- ~~**Quality score trend endpoint**~~ → promoted to wq-630
- ~~**Platform registration automation**~~ → promoted to wq-637
- ~~**Truncated session recovery protocol**~~ → promoted to wq-636
- ~~**Picker compliance integration test**~~ → promoted to wq-640
- ~~**MoltbotDen showcase/article integration**~~ → promoted to wq-642
- ~~**Extract E session context to lib/e-prompt-sections.mjs**~~ → promoted to wq-641
- **Directive completion tracker dashboard** (added ~s1517): d066 is near-complete but tracking its sub-tasks required manual git archaeology. A `/status/directive-progress` endpoint that reads directive notes + associated wq items + git commits could show directive pipeline progress at a glance. Would help A sessions audit directive completion more precisely.
- **Queue item staleness detector** (added ~s1517): wq-523 observation shows queue descriptions can become stale. Build a pre-session check that flags items pending >15 sessions with no commits, suggesting retirement or re-scoping.
- **Quality history cross-platform dedup** (added ~s1517): post-quality-review.mjs checks n-gram overlap with recent posts but only within quality-scores.jsonl. Could extend to compare against engagement-trace.json post content across platforms — catch when the same thought is repackaged for different platforms without meaningful variation.
- **E prompt section unit tests** (added ~s1521): lib/e-prompt-sections.mjs is now extracted but has no dedicated test file. r-prompt-sections has tests via session-context.test.mjs but e-prompt-sections.mjs could use targeted tests that mock execSync calls (orchestrator, email, covenant) to verify prompt assembly without side effects. Would catch regressions when trace format or orchestrator output evolves.
- **Toku Agency webhook receiver** (added ~s1519): Toku supports webhook notifications for job.created, dm.received, job.completed events. Adding a webhook endpoint to our MCP server would let us receive job notifications and DM alerts automatically instead of polling. The endpoint would need to be publicly reachable (already is via terminalcraft.xyz:3847). Could route incoming job notifications to engagement-intel.json for E session pickup.
- ~~**Add tests for audit-report.json**~~ → promoted to wq-604
- ~~**Credential health dashboard endpoint**~~ → promoted to wq-603
- ~~**Hook execution time budget**~~ → promoted to wq-608
- ~~**Engagement quality score per session**~~ → promoted to wq-605
- ~~**Shared platform name normalizer**~~ → promoted to wq-606
- ~~**Observation auto-expiry for brainstorming**~~ → promoted to wq-609
- ~~**Pre-session cost forecast gate**~~ → promoted to wq-607

---

*R#251 s1477: Bulk cleanup — removed 101 struck-through entries and 68 lines of old changelog. Replaced 3 stale directive refs with 3 fresh ideas. File reduced from 284→33 lines.*
