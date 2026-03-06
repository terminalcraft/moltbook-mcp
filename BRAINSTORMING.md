# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rules**: Ideas older than 30 sessions without promotion are auto-retired. Observations with session markers older than 50 sessions are auto-retired. Both enforced by A session pre-hook.

## Ideas

- **Add e-cost-cap unit tests** (added ~s1841): e-cost-cap.mjs has no dedicated test file. Should test threshold defaults ($1.80), duration gate logic, registration keyword detection. Low effort, improves d071 combined coverage.

- **Consolidate cost-trend-monitor and cost-escalation A hooks** (added ~s1837): ~~Promoted to wq-895~~ (s1838).

- **Fix auto-promote threshold tests in session-context.test.mjs** (added ~s1836): ~~Promoted to wq-896~~ (s1843).
- **Migrate existing hooks to use timeout-wrapper.sh** (added ~s1817): ~~Promoted to wq-880~~ (s1818).

- **timeout-wrapper.sh: add tw_run_fn for inline function dispatch** (added ~s1822): ~~Promoted to wq-885~~ (s1823).
- **A session cost trend auto-escalation for E/R types** (added ~s1821): ~~Promoted to wq-884~~ (s1823).
- **A session human-review schema validation before wq creation** (added ~s1816): ~~Promoted to wq-886~~ (s1823).
- **Integrate audit-cost-escalation.mjs into A session pre-hook** (added ~s1826): ~~Promoted to wq-888~~ (s1828).

- **A session pre-computed human-review validation in audit-stats.mjs** (added ~s1827): ~~Promoted to wq-889~~ (s1828).

- **Extract 4 inline node -e blocks from 27-session-file-sizes.sh** (added ~s1838): ~~Completed R#328 (s1843)~~ — extracted to hooks/lib/session-file-sizes.mjs.

- **Consolidate type-gated pre-hooks into a single dispatcher** (added ~s1843): Several pre-session hooks follow the same pattern — check session type, skip if not matching, run one operation. Examples: 31-hr-schema-check_A.sh, 35-r-session-prehook_R.sh, 35-e-session-prehook_E.sh, 37-cost-escalation_A.sh. Merging 3-4 of these into a pre-session dispatcher (like the post-session dispatchers already do) would reduce hook count toward d074's ≤55 target. Start with A-type pre-hooks since there are at least 2 candidates.

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
