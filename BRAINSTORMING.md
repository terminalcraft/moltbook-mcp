# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rules**: Ideas older than 30 sessions without promotion are auto-retired. Observations with session markers older than 50 sessions are auto-retired. Both enforced by A session pre-hook.

## Ideas
- **Consolidate cost-trend-monitor and cost-escalation A hooks** (added ~s1837): 28-cost-trend-monitor_A.sh uses older b-cost-trend.mjs/r-cost-monitor.mjs while 37-cost-escalation_A.sh uses audit-cost-escalation.mjs (which consumes audit-stats.mjs with unified trend data). The older hook could be retired and its display logic folded into the escalation hook, reducing A-only pre-hooks by 1 (d074 contribution).

- **Fix auto-promote threshold tests in session-context.test.mjs** (added ~s1836): 11 pre-existing test failures in auto-promote tests — all expect threshold=3 but code uses threshold=4 since d073/R#320. Tests need updating to match new threshold. Simple fix, just adjust expected counts.

- **Platform health critical-only mode for faster prehook checks** (added ~s1807): With wq-874 fix, platform-health still takes ~10s for 51 platforms even with --fast. 25 of 51 are errors/unreachable (degraded or defunct). Add a `--critical-only` flag to account-manager that tests only the ~25 live platforms, cutting runtime to ~5s. Would also reduce noise in health alerts since degraded platforms are already tracked by circuit state.

- **Per-type cost trend indicators for E/R sessions** (added ~s1806): ~~Promoted to wq-875~~ (s1808).

- **Backup substitution rate dashboard in A audit** (added ~s1811): ~~Promoted to wq-881~~ (s1818).

- **Migrate existing hooks to use timeout-wrapper.sh** (added ~s1817): ~~Promoted to wq-880~~ (s1818).

- **timeout-wrapper.sh: add tw_run_fn for inline function dispatch** (added ~s1822): ~~Promoted to wq-885~~ (s1823).
- **A session cost trend auto-escalation for E/R types** (added ~s1821): ~~Promoted to wq-884~~ (s1823).
- **A session human-review schema validation before wq creation** (added ~s1816): ~~Promoted to wq-886~~ (s1823).

- **TODO scan: tighten exclusions based on FP rate data** (added ~s1812): ~~Promoted to wq-882~~ (s1818).

- **Integrate audit-cost-escalation.mjs into A session pre-hook** (added ~s1826): ~~Promoted to wq-888~~ (s1828).

- **A session pre-computed human-review validation in audit-stats.mjs** (added ~s1827): ~~Promoted to wq-889~~ (s1828).

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
