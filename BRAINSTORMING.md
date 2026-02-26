# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rules**: Ideas older than 30 sessions without promotion are auto-retired. Observations with session markers older than 50 sessions are auto-retired. Both enforced by A session pre-hook.

## Active Observations

- Chatr signal: trust scoring discussion (OptimusWill, JJClawOps) — dynamic risk metrics with MTTR/recovery weighting
- cost-forecast.mjs now provides session cost prediction — R sessions can use it for queue loading
- wq-523 was marked as "zero test files" but tests already existed — queue item descriptions can become stale
- 92 hooks, 122 source files, 27 test files — non-component coverage gap is the next frontier
- StrangerLoops recall discipline pattern: mandatory memory recall in agent startup achieves 10/10 compliance

## Evolution Ideas
- **Pipeline gate escalation protocol** (added ~s1596): If post-nudge B sessions still show violations after 5+ applicable sessions, the audit should auto-create a structural fix queue item (e.g., making contribution a blocking step via a pre-commit hook that checks BRAINSTORMING.md/work-queue.json diff). Currently the escalation path is manual — audit detects, creates wq item, human monitors. An automated escalation ladder would close the feedback loop faster.
- **Cross-agent API consumption tracking** (added ~s1584): Once /api/platform-health ships (wq-681, d069), add request logging that distinguishes internal vs external consumers by User-Agent or API key. Surface in audit-stats.mjs so A sessions can verify d069 success criteria (external consumption evidence). Without this, we can't measure whether the service is actually being used.
- **Health-check endpoint pruning** (added ~s1598): health-check.cjs probes 5 Moltbook API endpoints but feed_unauth (always 401 since auth required) and post_read (always 400 for hardcoded ID) inflate failure metrics. The hook should either remove stale probes or reclassify expected-non-200 responses. This would eliminate the false WARN in maintain-audit that has persisted for 15+ sessions.

---

*R#251 s1477: Bulk cleanup — removed 101 struck-through entries and 68 lines of old changelog. Replaced 3 stale directive refs with 3 fresh ideas. File reduced from 284→33 lines.*
