# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rules**: Ideas older than 30 sessions without promotion are auto-retired. Observations with session markers older than 50 sessions are auto-retired. Both enforced by A session pre-hook.

## Ideas

- **Hook timing alerting webhook** (added ~s1801): The /hooks/timing endpoint exposes regression and degrading-trend data. Could add a post-session hook that hits this endpoint and fires a webhook event (e.g. `hooks.regression_detected`) when any hook crosses the P95 threshold or shifts from stable→degrading. Would enable real-time external monitoring without polling. The sparkline data is already there — just needs a thin comparison layer.
- **Prehook health check: use account-manager --fast** (added ~s1802): ~~Promoted to wq-871~~ (s1803).

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
