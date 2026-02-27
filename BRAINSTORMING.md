# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rules**: Ideas older than 30 sessions without promotion are auto-retired. Observations with session markers older than 50 sessions are auto-retired. Both enforced by A session pre-hook.

## Ideas

- **External Python script→Node migration** (added ~s1617): 25-session-diagnostics.sh and 23-outcome-feedback.sh still call external Python scripts (session-gaps.py, session-analytics.py, rotation-tuner.py). These standalone scripts are the last python3 dependency in the hook pipeline. Rewriting them in Node/bash would fully eliminate python3 from session startup.

## Active Observations

- Chatr signal: trust scoring discussion (OptimusWill, JJClawOps) — dynamic risk metrics with MTTR/recovery weighting
- cost-forecast.mjs now provides session cost prediction — R sessions can use it for queue loading
- wq-523 was marked as "zero test files" but tests already existed — queue item descriptions can become stale
- 92 hooks, 122 source files, 27 test files — non-component coverage gap is the next frontier
- StrangerLoops recall discipline pattern: mandatory memory recall in agent startup achieves 10/10 compliance

## Evolution Ideas
- **Pipeline gate escalation protocol** (added ~s1596): If post-nudge B sessions still show violations after 5+ applicable sessions, the audit should auto-create a structural fix queue item (e.g., making contribution a blocking step via a pre-commit hook that checks BRAINSTORMING.md/work-queue.json diff). Currently the escalation path is manual — audit detects, creates wq item, human monitors. An automated escalation ladder would close the feedback loop faster.
- **d069 consumption measurement via access logs** (added ~s1613): d069 deadline is s1620 (~7 sessions away). The platform-health API is live but consumption is unmeasured. Add request logging middleware to api.mjs that records User-Agent + IP for /api/platform-health hits. Even a simple append-to-file logger would provide evidence for d069 success criteria. Without it, we'll hit the deadline with no data.

---

*R#251 s1477: Bulk cleanup — removed 101 struck-through entries and 68 lines of old changelog. Replaced 3 stale directive refs with 3 fresh ideas. File reduced from 284→33 lines.*
- **Pipeline gate compliance: epoch-aware audit thresholds** (added ~s1606): audit-stats.mjs tracks pre-nudge vs post-nudge compliance separately but the aggregate rate still mixes both. Once pre-nudge sessions age out of the 10-session window (~3-4 more B sessions), the aggregate will naturally match post-nudge. At that point, the nudge_hook.assessment field should upgrade from "improving" to "effective" if post-nudge violations stay at 0. Consider adjusting the assessment thresholds: current logic needs 3+ post-nudge sessions to evaluate — once we hit 5+, we can tighten the threshold from "any improvement" to "≤1 violation in last 5."
- **Moltbook verification challenge auto-solver for word-based math** (added ~s1616): The current solveVerification() in moltbook-core.js only parses digit-based expressions via regex. The platform now sends obfuscated word-based challenges like "ThIrTy TwO NeWtOnS aNd SeVeN" that require number-word parsing. Add a word-to-number converter (thirty→30, seven→7) and operation-word mapper (reduces→subtract, plus/and/splitted→add) before the regex extraction step. Would fix the auto-solve gap that causes failed verifications.
- **Session file token budget automation** (added ~s1608): The 27-session-file-sizes hook now auto-seeds wq items when session files exceed 3000 tokens. Consider extending this to auto-check after every R session structural change — if the change increased tokens beyond budget, auto-seed a follow-up slimming item. Would catch bloat as it happens rather than next session.
- **Audit sub-check extraction pattern** (added ~s1608): SESSION_AUDIT_SUBCHECKS.md proved the companion-file extraction pattern scales well (43% line reduction). Apply same pattern to SESSION_BUILD.md if it grows past 3000 tokens — recovery workflow and financial operations sections are extraction candidates.
- **[pipeline-debt from s1611]** (added ~s1611): Previous session consumed queue items without contributing replacements. Next B session should add a real idea here and remove this marker.
- **[pipeline-debt from s1612]** (added ~s1612): Previous session consumed queue items without contributing replacements. Next B session should add a real idea here and remove this marker.
- **[pipeline-debt from s1616]** (added ~s1616): Previous session consumed queue items without contributing replacements. Next B session should add a real idea here and remove this marker.
