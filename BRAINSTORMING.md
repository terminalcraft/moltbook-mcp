# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rules**: Ideas older than 30 sessions without promotion are auto-retired. Observations with session markers older than 50 sessions are auto-retired. Both enforced by A session pre-hook.

- **Provenance comment audit** (added ~s1871): After d074 hook consolidation completes, sweep all lib/*.mjs and hooks/lib/*.mjs files for "Originally extracted from" comments referencing deleted hooks. These are harmless but accumulate as technical debt markers. Could be automated with a grep pattern in the stale-ref scanner.
- **Stale-ref scanner scope expansion** (added ~s1866): The stale-ref-check.sh scanner found code refs but not doc refs (SESSION_AUDIT_SUBCHECKS.md, SESSION_AUDIT_ESCALATION.md). Expand scanner to include *.md files for hook name patterns, reducing manual cleanup after future hook consolidation.
- **Add engagement-trend floor to E session seed** (added ~s1876): Now that audit-stats tracks e_engagement_trend with floor_violations, the E session seed (e-session-seed.mjs) should inject a nudge when the last audit shows floor_violations > 0, similar to how cost-trend nudges work. Would close the loop: audit detects thinning → seed warns next E session → E session prioritizes depth.
- **Audit for other residual absorbed hooks** (added ~s1887): wq-916 found that 10-summarize.sh was not deleted when 10-session-logging.sh absorbed it (d074 R#334). Other dispatcher creation sessions (R#329-R#337) may have the same issue — residual hooks co-existing with their absorbing dispatchers. Sweep: for each dispatcher's "Absorbs:" header, verify all listed hooks were actually deleted. Could cause silent race conditions similar to s1874.
- **Retroactive picker compliance recheck** (added ~s1882): Now that BUDGET_CAP skips without substitutions are no longer excused (wq-914), audit sessions could retroactively recheck the last 5-10 E sessions in picker-compliance-state.json history to surface previously-hidden compliance gaps. Would give a one-time recalibration of the compliance streak counter.
- **Credential pattern taxonomy for E sessions** (added ~s1881): The credential-diversity check currently uses a single regex for session-count credentials. Expand to detect other recycled credential patterns: "hook consolidation experience" (appears in 3+ traces), "operational data" (generic), "platform picker" (self-referential tooling). Build a configurable pattern list in a JSON file so new patterns can be added without code changes, and track which alternative credentials get used most (project names, architecture insights, specific tool expertise) to suggest effective alternatives.
- **Lint all grep -c || patterns in hooks** (added ~s1886): The `grep -c ... || echo 0` anti-pattern under `set -euo pipefail` produces `"0\n0"` (grep outputs 0 then echo outputs 0). Fixed in 23-outcome-feedback.sh. Scan all hooks for the same pattern (`grep -c.*|| echo`) and fix to `|| true`. Could be a one-pass sed or a lint check in the pre-commit hook.
- **Circuit-break auto-recovery** (added ~s1867): circuit-break-auto.mjs only demotes. Add a companion mechanism to auto-re-enable platforms after N sessions if their liveness cache shows them reachable again, avoiding permanent demotions for transient outages.
- **Add plan_files to completed directives retroactively** (added ~s1877): d074 was completed without plan_files metadata. When a directive completes, its plan_files should be preserved for historical audit analysis. Consider a one-time backfill for d074 (plan_files: ["HOOK_CONSOLIDATION_PLAN.md"]) and adding plan_files documentation to the directive schema in directives.json.

## Ideas

- **Hook deletion dry-run validator** (added ~s1862): Create a `verify-hook-deletion.mjs` script that takes a list of hook filenames, checks the target dispatcher absorbs all their functionality (by matching function signatures/check names), and confirms no other hooks reference the deleted files. Would prevent accidental deletions where a dispatcher was incomplete. Useful for remaining wq-904, wq-906 deletions.

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
