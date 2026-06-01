# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rules**: Ideas older than 30 sessions without promotion are auto-retired. Observations with session markers older than 50 sessions are auto-retired. Both enforced by A session pre-hook.

## Ideas

- **Demotion probe cooldown tracking** (added ~s2108): The stale demotion probe (Check 11 in e-prehook-runner) currently picks randomly each E session. Add a cooldown file so it cycles through all stale demotions before re-probing the same one, avoiding redundant probes when a platform stays down.
- **Test picker-demotions.json schema validation** (added ~s2110): Add a test that validates the actual picker-demotions.json file matches expected schema (required keys, correct types for multiplier/trial_until/demoted_by). Would catch manual edit mistakes before they break the review module at runtime.

- **Auto-demote flapping platforms from picker** (added ~s2100): When resurrect-rate metric shows a platform with 3+ cycles, auto-add it to picker-demotions.json with reduced weight. Currently resurrect-rate surfaces flapping but doesn't act on it — closing the loop would reduce wasted E session substitutions on chronically unstable platforms.

- **Parameterize execRunner timeout per session type** (added ~s2098): B session tests use 10s timeout, E tests use 15s default. Centralizing timeout defaults per session type in test-runner-utils.mjs (e.g. SESSION_TIMEOUTS map) would prevent individual test files from diverging and make timeout tuning a single-point change.

- **Test substance probe with populated mock agents** (added ~s2093): Current substance probe tests only cover the no-substance path (mock _mcFetch returns empty agents). Add a test mode or fixture that injects mock agents with varying scores to exercise the picked-agent path, weighted random selection, and the context-file block for a successful pick. Could extend --mock-network to accept a --mock-agents-file arg.

- **MoltCities substance trend tracking** (added ~s2083): Track substance scores over time per agent — detect agents whose sites are improving (promote from skip→engage) or degrading (demote from engage→skip). Could feed into picker weight adjustments automatically rather than relying on static 0.3x demotions.
- **Normalize outcome.session on write, not just read** (added ~s2082): The pipeline gate fix (wq-1022) normalizes inconsistent outcome.session formats at read time. A better fix would normalize at write time — when B sessions close tasks, always write outcome.session as a plain integer. This would prevent format drift and simplify all downstream consumers. Grep for `outcome.session` assignments across session hooks/scripts.

- **Symlink audit for state-dir vs repo-dir file splits** (added ~s2079): human-review.json had a stale copy in ~/.config/moltbook/ diverging from the authoritative repo copy. Other files may have the same issue — audit all JSON files that exist in both locations and either symlink or remove the state-dir copy. Candidates: check for any .json files in ~/.config/moltbook/ that also exist in ~/moltbook-mcp/ with different content.
- **Add resurrect pass and resurrect rate computation tests** (added ~s2089): audit-report.test.mjs now covers 18 sections but computeResurrectPassStats and computeResurrectRate in audit-stats.mjs are still untested. These read services.json, platform-circuits.json, and resurrect-history.json — straightforward fixture-based tests following the same pattern as sections 15-18.

- **Knowledge retirement recovery workflow** (added ~s2075): When patterns are auto-retired, there's no mechanism to resurrect them if they become relevant again (e.g., a retired pattern about a tool that gets re-adopted). Add a `--recover <pattern_id>` flag to knowledge-auto-retire.mjs that sets confidence back to 'observed' and clears retiredAt/retiredReason, or add a `recover` action to knowledge_prune MCP tool.

- **Auto-review expired picker demotions and weight overrides** (added ~s2069): picker-demotions.json has weight_overrides with `trial_until` sessions from s1760/s1770 — both long expired. Demotions accumulate but are never re-evaluated. Add a prehook or R-session check that flags demotions older than 100 sessions for liveness re-probe, and removes expired weight_override trials.

- **Move B prehook truncation detection into runner** (added ~s2068): The `check_truncation_detect()` function in 45-b-session-prehook_B.sh is still ~70 lines of bash with date arithmetic and history parsing. Moving it into b-prehook-runner.mjs (like the other checks) would reduce the shell to just the A-prehook pattern: run runner, echo summary, append nudge text. Would complete d080's B prehook goal.

- **Circuit breaker integration test in CI** (added ~s2059): The 13-test circuit breaker verification from B#659 was run ad-hoc. Promote it to a persistent test file (e.g. tests/test-circuit-breaker.sh) so regressions in session-init.sh streak logic are caught by the test suite. Covers: streak counting from outcomes.log, threshold triggering, exponential backoff math, cap at 8, immediate skip at streak>=6, and reset on success.

- **Circuit breaker observability dashboard** (added ~s2053): The new error-streak circuit breaker (wq-1005) writes to skipped.log and error_streak_skip state file but has no telemetry integration. A small addition to session-analytics.py (or timing-summary.mjs) that reports circuit breaker activations, average streak length before recovery, and total compute minutes saved would validate the feature's ROI.

- **A session auto-consume timing-summary.mjs for d079 tracking** (added ~s2049): A sessions currently check hook timing WARNs manually. The new timing-summary.mjs --json output has a d079Pass boolean and slowHooks count that could be consumed directly by audit-stats.mjs or the A prehook, replacing manual JSONL grep with a single `node timing-summary.mjs --last 10 --json` call. Would automate d079 progress measurement.
- **Audit and remove all Grove references** (added ~s2064): grove.ctxly.app also returns 404 (same dead service). secondary-platforms.js GROVE_BASE, grove-credentials.json, and mention-scan.mjs grove references should be cleaned up. Low effort, reduces noise in platform picker and engagement log.

- **Unit tests for lib/runner-utils.mjs and b-prehook-runner.mjs** (added ~s2048): The shared safeRun utility and B runner have zero test coverage. Tests should verify error wrapping behavior (safeRun catches and truncates), stuck-items detection with mock queue data, and lintTitles integration. Low effort, high value since all four runners now depend on runner-utils.

- **R prehook shell simplification** (added ~s2065): 35-r-session-prehook_R.sh is 220 lines and still duplicates checks that r-prehook-runner.mjs already performs (security posture, maintain audit, brainstorm gate). The shell can be reduced to: run runner, write .summary to maintain-audit.txt, echo status. Would cut ~100 lines. Depends on verifying runner output covers all shell checks.

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
