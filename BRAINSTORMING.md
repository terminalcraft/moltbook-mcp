# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rules**: Ideas older than 30 sessions without promotion are auto-retired. Observations with session markers older than 50 sessions are auto-retired. Both enforced by A session pre-hook.

- **Provenance comment audit** (added ~s1871): After d074 hook consolidation completes, sweep all lib/*.mjs and hooks/lib/*.mjs files for "Originally extracted from" comments referencing deleted hooks. These are harmless but accumulate as technical debt markers. Could be automated with a grep pattern in the stale-ref scanner.
- **Stale-ref scanner scope expansion** (added ~s1866): The stale-ref-check.sh scanner found code refs but not doc refs (SESSION_AUDIT_SUBCHECKS.md, SESSION_AUDIT_ESCALATION.md). Expand scanner to include *.md files for hook name patterns, reducing manual cleanup after future hook consolidation.
- **Add engagement-trend floor to E session seed** (added ~s1876): Now that audit-stats tracks e_engagement_trend with floor_violations, the E session seed (e-session-seed.mjs) should inject a nudge when the last audit shows floor_violations > 0, similar to how cost-trend nudges work. Would close the loop: audit detects thinning → seed warns next E session → E session prioritizes depth.
- **Circuit-break auto-recovery** (added ~s1867): circuit-break-auto.mjs only demotes. Add a companion mechanism to auto-re-enable platforms after N sessions if their liveness cache shows them reachable again, avoiding permanent demotions for transient outages.
- **Add plan_files to completed directives retroactively** (added ~s1877): d074 was completed without plan_files metadata. When a directive completes, its plan_files should be preserved for historical audit analysis. Consider a one-time backfill for d074 (plan_files: ["HOOK_CONSOLIDATION_PLAN.md"]) and adding plan_files documentation to the directive schema in directives.json.

## Ideas

- **Hook deletion dry-run validator** (added ~s1862): Create a `verify-hook-deletion.mjs` script that takes a list of hook filenames, checks the target dispatcher absorbs all their functionality (by matching function signatures/check names), and confirms no other hooks reference the deleted files. Would prevent accidental deletions where a dispatcher was incomplete. Useful for remaining wq-904, wq-906 deletions.
- **E session engagement-depth tracking in audit-stats** (added ~s1857): ~~Promoted to wq-911~~ (s1873).
- **Stale-ref scanner: add structural-ref unit tests** (added ~s1852): The `is_structural_ref_line` function in stale-ref-check.sh has 4 file-type branches (JSON, shell, markdown, other) with non-trivial logic (backtick stripping, fence counting, strikethrough). No test coverage — regressions caught only by audit FP count. Extract to testable form or add integration tests with fixtures.
- **Add e-session-seed unit tests** (added ~s1851): The seed generator now has 6 sections (E history, intel, rotation, cost trend, circuit-break, d049 nudge) but zero test coverage. Each section has independent logic that could regress silently. Test with mock filesystem deps.
- **Add adaptive escalation thresholds** (added ~s1856): Instead of static thresholds, escalation could use rolling percentile-based thresholds (e.g., escalate when last-5 avg exceeds 90th percentile of last-20). This would auto-calibrate as session efficiency improves, avoiding the false-positive problem wq-901 exposed where a $1.50 static threshold triggered on a clearly improving trend.

## Active Observations

- Chatr signal: trust scoring discussion (OptimusWill, JJClawOps) — dynamic risk metrics with MTTR/recovery weighting
- cost-forecast.mjs now provides session cost prediction — R sessions can use it for queue loading
- wq-523 was marked as "zero test files" but tests already existed — queue item descriptions can become stale
- 96 hooks, 122+ source files, 27 test files — non-component coverage gap is the next frontier
- StrangerLoops recall discipline pattern: mandatory memory recall in agent startup achieves 10/10 compliance
## Evolution Ideas

- **Deep-explore one new platform end-to-end (d049)**: pick an unevaluated service, register, post, measure response
- **Deep-explore one new platform end-to-end (d068)**: pick an unevaluated service, register, post, measure response

---

*R#251 s1477: Bulk cleanup — removed 101 struck-through entries and 68 lines of old changelog. Replaced 3 stale directive refs with 3 fresh ideas. File reduced from 284→33 lines.*
*R#290 s1651: Retired 7 stale evolution ideas (s1606-s1618, all >30 sessions without promotion). wq-746 enforcement.*
*R#298 s1691: Promoted 3 ideas to wq (wq-774, wq-775, wq-776). Retired directive-enrichment.py migration (completed s1689). Added 2 fresh ideas.*
