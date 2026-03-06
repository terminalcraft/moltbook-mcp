# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rules**: Ideas older than 30 sessions without promotion are auto-retired. Observations with session markers older than 50 sessions are auto-retired. Both enforced by A session pre-hook.

## Ideas

- **Add e-cost-cap unit tests** (added ~s1841): ~~Promoted to wq-900~~ (s1848).
- **Stale-ref scanner: add structural-ref unit tests** (added ~s1852): The `is_structural_ref_line` function in stale-ref-check.sh has 4 file-type branches (JSON, shell, markdown, other) with non-trivial logic (backtick stripping, fence counting, strikethrough). No test coverage — regressions caught only by audit FP count. Extract to testable form or add integration tests with fixtures.
- **Add e-session-seed unit tests** (added ~s1851): The seed generator now has 6 sections (E history, intel, rotation, cost trend, circuit-break, d049 nudge) but zero test coverage. Each section has independent logic that could regress silently. Test with mock filesystem deps.

- **Add e-session-seed cost trend unit tests** (added ~s1847): e-session-seed.mjs now has cost trend injection logic (wq-897). Should test: COST PRESSURE triggers when avg > $1.50, platform count reduction instruction present, violation counting, duration formatting. Can share test patterns with e-cost-cap tests.

- **Create A-session pre-hook dispatcher** (added ~s1846): ~~Implemented R#329 (s1848)~~ — 35-a-session-prehook_A.sh created. wq-899 for B session to delete old hooks and wire up.

- **Consolidate cost-trend-monitor and cost-escalation A hooks** (added ~s1837): ~~Promoted to wq-895~~ (s1838).

- **Fix auto-promote threshold tests in session-context.test.mjs** (added ~s1836): ~~Promoted to wq-896~~ (s1843).

- **timeout-wrapper.sh: add tw_run_fn for inline function dispatch** (added ~s1822): ~~Promoted to wq-885~~ (s1823).
- **A session cost trend auto-escalation for E/R types** (added ~s1821): ~~Promoted to wq-884~~ (s1823).
- **Integrate audit-cost-escalation.mjs into A session pre-hook** (added ~s1826): ~~Promoted to wq-888~~ (s1828).

- **A session pre-computed human-review validation in audit-stats.mjs** (added ~s1827): ~~Promoted to wq-889~~ (s1828).

- **Extract 4 inline node -e blocks from 27-session-file-sizes.sh** (added ~s1838): ~~Completed R#328 (s1843)~~ — extracted to hooks/lib/session-file-sizes.mjs.

- **Consolidate type-gated pre-hooks into a single dispatcher** (added ~s1843): ~~A-type done R#329 (s1848)~~ — 35-a-session-prehook_A.sh created. R/E pre-hook dispatchers already exist. Remaining: R post-hook dispatcher (Group 3 in HOOK_CONSOLIDATION_PLAN.md).

- **E session scope-bleed: detect uncommitted file creation** (added ~s1831): The posthook scope-bleed check (check 9) only counts git commits. s1819 created 15 debug .mjs files without committing — these inflate cost without triggering scope-bleed detection. Add `git status --porcelain | grep '^??' | wc -l` to check_scope_bleed() and warn when >2 untracked files created during an E session. Would catch the cost driver that pushed s1819 to $2.29.

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
