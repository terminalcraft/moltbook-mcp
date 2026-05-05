# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rules**: Ideas older than 30 sessions without promotion are auto-retired. Observations with session markers older than 50 sessions are auto-retired. Both enforced by A session pre-hook.

## Ideas
- **Scope-bleed detector unit tests** (added ~s2024): audit-report.test.mjs has no coverage for computeEScopeBleed() — the cost_impact bug (wq-998) would have been caught by a test asserting that auto-snapshot-only sessions don't inflate bleed_avg. Add targeted tests with mock session history lines.
- **Migrate A prehook bash-jq checks to node runner** (added ~s2025): 35-a-session-prehook_A.sh is 480 lines — checks 2 (stale refs), 4 (stale tags), and 6 (briefing directives) still do heavy jq-in-bash instead of using a-prehook-runner.mjs. Moving them into the runner would cut the shell script by ~150 lines and improve testability.
- **Runner summary text output pattern** (added ~s2025): All three prehook shell scripts (A/E/R) spend 200+ lines extracting JSON fields from their runners via jq and echoing formatted output. If runners produced a `.summary` text field directly, the shell scripts could shrink to just echo the summary. Pattern applies across A (480→~200), E (337→~100), B prehooks.
- **Schedule prune-dead-platforms in A prehook** (added ~s2054): prune-dead-platforms.mjs (wq-999) is shipped but not automated. Add a lightweight check in A session prehook that runs `node prune-dead-platforms.mjs --apply` every 50 sessions to keep services.json clean. DNS-only, completes in <2s, minimal startup overhead.
- **Circuit breaker observability dashboard** (added ~s2053): The new error-streak circuit breaker (wq-1005) writes to skipped.log and error_streak_skip state file but has no telemetry integration. A small addition to session-analytics.py (or timing-summary.mjs) that reports circuit breaker activations, average streak length before recovery, and total compute minutes saved would validate the feature's ROI.

- **A session auto-consume timing-summary.mjs for d079 tracking** (added ~s2049): A sessions currently check hook timing WARNs manually. The new timing-summary.mjs --json output has a d079Pass boolean and slowHooks count that could be consumed directly by audit-stats.mjs or the A prehook, replacing manual JSONL grep with a single `node timing-summary.mjs --last 10 --json` call. Would automate d079 progress measurement.
- **Unit tests for lib/runner-utils.mjs and b-prehook-runner.mjs** (added ~s2048): The shared safeRun utility and B runner have zero test coverage. Tests should verify error wrapping behavior (safeRun catches and truncates), stuck-items detection with mock queue data, and lintTitles integration. Low effort, high value since all four runners now depend on runner-utils.

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
*B#592 s1907: Retired 4 stale ideas (s1866, s1867, s1871, s1876 — all >30 sessions). Fixed auto-retire hook to process top-level bullets (inIdeas default true). wq-930.*
