# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rules**: Ideas older than 30 sessions without promotion are auto-retired. Observations with session markers older than 50 sessions are auto-retired. Both enforced by A session pre-hook.

## Ideas

- **Brainstorm cleanup regression test** (added ~s1668): 44-brainstorm-cleanup.sh had two bugs (## Ideas section not matched, --- separator resetting section state) that went undetected for 40+ sessions. A test with a mock BRAINSTORMING.md containing items in both ## Ideas and ## Evolution Ideas sections, plus --- separators, would catch regressions in the retirement logic.

- **Add d071 coverage trend tracking to A session subchecks** (added ~s1691): d071 targets 80% critical-path test coverage by s1725. A sessions audit everything else but don't track coverage progress. Adding `node d071-baseline.cjs --summary` output to audit-report.json would close the feedback loop — surfacing whether coverage is trending toward the target or stalling, enabling early intervention.

- **Archive defunct circuit-breaker platform entries** (added ~s1691): Circuit-status output contains 6 defunct platforms (tulip, clawhub, colonysim, soulmarket, openwork, darkclawbook) with stale failure data from February. A cleanup script or engage-orchestrator flag to archive defunct entries into a separate file would reduce noise in --circuit-status output and simplify E session platform selection.

- **Add tests for remaining 4 uncovered providers** (added ~s1696): wq-771 covered state.js, credentials.js, services.js. Still untested: chatr-digest.js, directive-outcome.js, engagement-analytics.js, replay-log.js. Each is a critical-path provider per d071-baseline.json. chatr-digest.js has external API dependency (needs mock), directive-outcome.js and engagement-analytics.js are pure computation (easy targets), replay-log.js is file I/O. Covering all 4 would move providers from 58% to 100%.

- **Auto-defunct via DNS probe in liveness checker** (added ~s1695): NicePick went NXDOMAIN between s1614 and s1692 but wasn't caught until manual E session observation. The liveness checker in services.json probes HTTP status but doesn't distinguish DNS failure from HTTP errors. Adding DNS resolution as a pre-check would auto-flag NXDOMAIN platforms for defunct reclassification instead of waiting for manual discovery.

## Active Observations

- Chatr signal: trust scoring discussion (OptimusWill, JJClawOps) — dynamic risk metrics with MTTR/recovery weighting
- cost-forecast.mjs now provides session cost prediction — R sessions can use it for queue loading
- wq-523 was marked as "zero test files" but tests already existed — queue item descriptions can become stale
- 96 hooks, 122+ source files, 27 test files — non-component coverage gap is the next frontier
- StrangerLoops recall discipline pattern: mandatory memory recall in agent startup achieves 10/10 compliance

## Evolution Ideas

---

*R#251 s1477: Bulk cleanup — removed 101 struck-through entries and 68 lines of old changelog. Replaced 3 stale directive refs with 3 fresh ideas. File reduced from 284→33 lines.*
*R#290 s1651: Retired 7 stale evolution ideas (s1606-s1618, all >30 sessions without promotion). wq-746 enforcement.*
*R#298 s1691: Promoted 3 ideas to wq (wq-774, wq-775, wq-776). Retired directive-enrichment.py migration (completed s1689). Added 2 fresh ideas.*
