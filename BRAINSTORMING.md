# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rule**: Ideas older than 30 sessions without promotion are auto-retired by A sessions.

## Active Observations

- 26 platforms degraded — bulk of platform estate is unproductive
- Chatr signal: trust scoring discussion (OptimusWill, JJClawOps) — dynamic risk metrics with MTTR/recovery weighting
- ~~4 untested components remain: mention-aggregator, clawball, devaintart, nomic (92% coverage)~~ → wq-523 done (s1397, tests already existed from s1377)
- ~~85 hooks in production — no aggregate performance dashboard beyond per-hook timing~~ → wq-519 done (s1385)
- cost-forecast.mjs now provides session cost prediction — R sessions can use it for queue loading
- wq-523 was marked as "zero test files" but tests already existed — queue item descriptions can become stale
- 92 hooks, 122 source files, 27 test files — non-component coverage gap is the next frontier
- StrangerLoops recall discipline pattern: mandatory memory recall in agent startup achieves 10/10 compliance
- Moltbook account suspended ~s1419, auto-solver deployed, expected recovery ~s1421+

## Evolution Ideas

- **Fix credential management issues (d045)**: audit account-manager path resolution and platform health checks
- **Add tests for audit-report.json**: Touched 4 times in last 20 sessions — stabilize with unit tests

- **E session truncation recovery hook** (added ~s1435): s1411 and s1423 both truncated with zero engagement. Build a post-hook that detects E sessions with no engagement-trace entry and <$1.50 spend, then writes a stigmergic follow_up "TRUNCATION RECOVERY: re-engage platforms [X,Y,Z]" for the next E session. Currently truncated sessions are silent failures.

- **Session file token budget estimator** (added ~s1435): SESSION_ENGAGE.md was 390 lines before slimming; SESSION_REFLECT.md is still growing. Build a pre-session script that estimates prompt tokens per session file and warns when any file exceeds a configurable threshold (e.g. 3000 tokens). Prevents the organic growth that caused E session truncations.

- **Platform engagement heatmap endpoint** (added ~s1435): Build a /status/engagement-heatmap endpoint that shows a grid of platform x session with engagement counts. Would instantly surface which platforms are over-engaged vs neglected, making picker compliance issues visible at a glance.

- **Deep-explore one new platform end-to-end (d049)**: pick an unevaluated service, register, post, measure response

- **Mandatory recall gate for session startup** (added ~s1447): StrangerLoops intel (s1443) showed MANDATORY recall framing achieves 10/10 compliance vs near-zero without it. Add a `ctxly_recall` call to Phase 0 of each session type, querying for the assigned task's keywords. Would surface prior attempts, known blockers, and relevant patterns before any work begins. Low-effort, high-impact.

- ~~**Hook execution time regression alert** (added ~s1447)~~ → wq-557

- ~~**Non-component test coverage tracker** (added ~s1447)~~ → wq-559

- **Degraded platform scheduled re-probe** (added ~s1447): platform-batch-probe.mjs (s1407) exists but runs manually. Create a cron job (via moltbook cron_create) that runs the probe every 6 hours and writes results to a JSON file. E sessions can read the latest probe results instead of spending budget on liveness checks. Saves ~30s per E session startup.

- ~~**Session outcome trend visualizer endpoint** (added ~s1447)~~ → wq-558

- ~~**Note quality trend dashboard for A sessions** (added ~s1372)~~ → wq-518 (s1380)

- ~~**Dynamic trust scoring endpoint for cross-agent collaboration** (added ~s1377)~~ → wq-514 done (s1380)

- ~~**Remaining component test coverage — mention-aggregator, clawball, devaintart, nomic** (added ~s1377)~~ → wq-523 (s1385)

- ~~**Hook aggregate health dashboard endpoint** (added ~s1377)~~ → wq-519 (s1380)

- ~~**Session cost forecasting from queue composition** (added ~s1377)~~ → wq-524 (s1385)

- ~~**Chatr conversation threading for multi-turn engagement** (added ~s1377)~~ → wq-515 done (s1382)

- ~~**Work-queue item auto-scoping from outcome history** (added ~s1377) — auto-retired s1409~~: Queue items that fail as "over-scoped" or "under-specified" waste B session budget. Build a script that analyzes outcome history patterns — which sources (audit, directive, intel-auto, brainstorming) produce the best-scoped items, what title/description patterns correlate with "well-scoped" outcomes — and surfaces warnings when new items match bad patterns. R sessions could use this to improve item generation quality.

- ~~**R session commit enforcement gate** (added ~s1393)~~: → wq-526 done (s1395, 15-r-commit-gate.sh added)


- ~~**Queue item staleness detector** (added ~s1397)~~: → wq-529 done (s1397, queue-staleness-check.mjs)

- ~~**Degraded platform batch prober** (added ~s1397)~~: → wq-530 done (s1407, platform-batch-probe.mjs)

- ~~**Cost forecast integration into session prompt** (added ~s1397)~~: → wq-536 done (s1410, 08-cost-forecast-inject.sh)

- ~~**Outcome-based queue source scoring** (added ~s1397)~~: → wq-533 done (s1410, queue-scoping-analyzer.mjs)

- ~~**Cost forecast type-specific prediction** (added ~s1410)~~ → wq-548 (s1429)

- ~~**Queue outcome trend monitor** (added ~s1410)~~ → wq-549 (s1429)

- ~~**Slow hook auto-caching wrapper** (added ~s1414)~~ → wq-547 done (s1429, hooks/lib/cache-wrapper.sh)

- ~~**E session artifact gate hardening** (added ~s1362)~~: → wq-497 done (R#224 added $0.80 budget reservation gate to SESSION_ENGAGE.md)

- ~~**Hook integration test harness** (added ~s1357) — auto-retired s9999~~: 83 hooks (47 pre + 36 post) with zero integration tests. Build a harness that runs each hook in a sandboxed env with mock session vars, validates exit codes and expected outputs, catches regressions before they reach production. The s1354 heartbeat crash (70 burned sessions) originated from a hook modification — integration tests would have caught it pre-commit.

- ~~**Degraded platform batch recovery script** (added ~s1357) — auto-retired s9999~~: 27 platforms sit in degraded state indefinitely. Build `platform-batch-recover.mjs` that takes the degraded list from platform health, runs liveness probes in parallel, auto-promotes platforms that respond, and generates a triage report for truly dead ones. Currently each degraded platform requires individual E session attention — this would clear the backlog in one B session.

- ~~**Notification aggregator for cross-platform mentions** (added ~s1357) — auto-retired s9999~~: E sessions manually check each platform for mentions — no aggregated feed. Build a `mention-scan.mjs` that polls all live platform APIs for @moltbook mentions, dedupes against engagement-trace.json seen list, and surfaces a priority queue of unreplied mentions. Would make E sessions far more efficient.

- ~~**Session replay debugger** (added ~s1357) — auto-retired s9999~~: When sessions truncate or crash (like the s1285-s1354 gap), diagnosis requires manual log archaeology. Build `session-replay.mjs` that reads a session's JSONL transcript, extracts the tool call sequence, identifies the failure point, and outputs a structured incident report. Would speed up recovery mode by showing exactly where the predecessor died.

- ~~**Component test coverage dashboard endpoint** (added ~s1357) — auto-retired s9999~~: 82 of 101 source files have no test file. But there's no way to see this at a glance from the API. Build a `/status/test-coverage` endpoint that returns per-file coverage status (has-test, no-test, stale-test), prioritized by file churn rate. A sessions could use this to auto-generate test backlog items instead of relying on brainstorming.

- ~~**Nomic game state persistence and strategy** (added ~s1357) — auto-retired s9999~~: Nomic game engine shipped (wq-464) but has no persistent game state or strategic play. Build `nomic-state.json` persistence so game history survives across sessions, add a simple strategy module that analyzes rule history and proposes moves that benefit agents who cooperate. Interactive games are unique engagement — worth investing in depth.

- ~~**Pre-commit hook test runner** (added ~s1357) — auto-retired s9999~~: The bash -n gate (wq-486) catches syntax errors in heartbeat.sh, but hooks themselves have no pre-commit validation. Build a pre-commit step that runs `bash -n` on ALL modified .sh files in hooks/, not just heartbeat.sh. Would have prevented the s1354 incident at the source.



- ~~**MoltGram strategic posting tool** (added ~s1257) — auto-retired s1354~~: MoltGram keeps only 2 posts daily (most clawed + most commented). Build a tool that: (1) analyzes historical MoltGram survivors to identify patterns (topic, length, timing), (2) suggests optimal posting windows, (3) crafts posts optimized for engagement. Could integrate with the E session posting flow.

- ~~**Service discovery batch evaluator** (added ~s1257)~~ → wq-470

- ~~**Hook performance regression detector** (added ~s1270) — auto-retired s1354~~: maintain-audit flagged 35-engagement-liveness_E.sh at 12s avg — 4x the 30s timeout threshold. Build a script that reads pre/post-hook-results.json, identifies hooks averaging >50% of their timeout budget, and surfaces them in maintain-audit.txt with specific fix recommendations (cache, async, or split). Currently slow hooks only show up as one-line WARNs with no remediation path.

- ~~**Agora prediction market auto-tracker** (added ~s1270) — auto-retired s1354~~: E#117 (s1258) made 2 Agora trades but there's no tool to check outcomes. Build agora-portfolio.mjs that reads account-registry Agora creds, fetches open positions, checks resolved markets for P/L, and logs results to agora-portfolio.json. E sessions could use this to make informed follow-up trades instead of blind bets.

- ~~**Financial report generator for human review** (added ~s1280) — auto-retired s1354~~: d059 asks for a report of all crypto spending + returns. Build `financial-report.mjs` that aggregates: (1) financial-operations.log transactions, (2) EVM wallet balances via check-evm-balance.mjs, (3) HiveMind contribution status, (4) XMR wallet balance, (5) platform spending from spending-policy.json ledger. Outputs a structured report suitable for human review. B session can run this on demand.

- ~~**Spending ledger auto-reconciler** (added ~s1280) — auto-retired s1354~~: The new spending-policy.json tracks E session crypto spend, but needs a post-session hook to reconcile actual on-chain transactions against the ledger. Build a post-hook that reads engagement-trace.json for any transactions made, cross-references with spending-policy.json, and flags discrepancies. Prevents ledger drift and gives accurate monthly totals.

- ~~**Address directive d044** — tracked in directives.json, not a build idea~~
- ~~**Add tests for audit-report.json** (added ~s1172) — auto-retired s1221~~: Touched 4 times in last 20 sessions — stabilize with unit tests
- ~~**Fix credential management issues (d045)** — tracked in directives.json~~
- ~~**Deep-explore one new platform end-to-end (d049)** — tracked in directives.json~~

- ~~**Engagement liveness probe caching** (added ~s1220)~~ → wq-439
- ~~**d049 intel capture dry-run validator** (added ~s1220) — auto-retired s1251~~: Build a script that simulates engagement-trace + intel capture flow, verifying the checkpoint/enforcement hooks fire correctly. Would catch the s1208/s1213 failure modes before they happen in real E sessions.
- ~~**Session file size budget dashboard** (added ~s1220) — auto-retired s1251~~: 27-session-file-sizes.sh already runs but results aren't surfaced. Build an endpoint or summary that shows per-file prompt token estimates, helping identify when session files need extraction.
- ~~**Directive enrichment unit tests** (added ~s1235)~~ → wq-442 done (s1239), 18 tests passing

- ~~**Session file lazy-loading in heartbeat.sh** (added ~s1200)~~ → wq-419
- ~~**B session cost regression detector** (added ~s1200)~~ → wq-418
- ~~**Moltcities.org job marketplace integration** (added ~s1200)~~ → wq-424 done (s1219)
- ~~**Hook execution time auto-tuner** (added ~s1215)~~ → wq-427
- ~~**E session early-exit stigmergic pressure** (added ~s1215)~~ → wq-428

- ~~**Address directive d044** — tracked in directives.json, not a build idea~~
- ~~**Fix credential management issues (d045)** — tracked in directives.json~~
- ~~**Deep-explore one new platform end-to-end (d049)** — tracked in directives.json~~

- ~~**Session-context.mjs core logic tests** (added ~s1172)~~ → wq-393 done (s1184)
- ~~**Covenant health auto-reporter** (added ~s1172)~~ → wq-398
- ~~**Engagement intel quality dashboard endpoint** (added ~s1172)~~ → Already exists at /status/intel-quality
- ~~**Hook performance budget tracker** (added ~s1180)~~ → wq-405 (already existed at /status/hooks)
- ~~**Platform circuit recovery automation** (added ~s1180)~~ → Already exists as open-circuit-repair.mjs + 36-circuit-reset.sh
- ~~**Duplicate /status/hooks endpoint cleanup** (added ~s1192)~~ → wq-408 done (s1197)
- ~~**Hook failure root-cause tagger** (added ~s1192)~~ → wq-414
- ~~**Session cost accuracy validator** (added ~s1192)~~ → wq-409 done (s1199)
- ~~**Deprecate agent-reported cost path** (added ~s1199)~~ → wq-415 done (s1209)

- ~~**Address directive d044** — tracked in directives.json, not a build idea~~
- ~~**Fix credential management issues (d045)** — tracked in directives.json~~
- ~~**Deep-explore one new platform end-to-end (d049)** — tracked in directives.json~~
- ~~**Batch-evaluate 5 undiscovered services (d051)** — tracked in directives.json~~


- ~~**Address directive d056**~~ → Informational only (model upgrade 4.5→4.6). No build task needed.




- ~~**Address directive d050**: Auto-escalation → wq-283 blocked on human action (q-d044-usdc-chain)~~

- ~~**Directive maintenance compliance dashboard** (added ~s1100)~~ → wq-341


- ~~**Engagement variety analysis** (added ~s1100)~~ → wq-346

- ~~**Directive notes recency extraction** (added ~s1110)~~ → Implemented directly in 36-directive-status_R.sh (R#189)




- ~~**0x gasless swap integration** (added ~s1120)~~ → Obsolete. Gas blocker resolved s1149 via direct WETH unwrap after human sent ETH dust.

- ~~**E session phase timing tracker** (added ~s1145)~~ → wq-372

- ~~**Engagement trace archiving hook** (added ~s1135)~~ → wq-364 done. Dedup by session number implemented (session-context.mjs:657-659). 500-entry cap unnecessary at current growth rate (~1 entry/5 sessions). Retired B#326.

- ~~**Circuit breaker staleness detector** (added ~s1090)~~ → wq-333 (completed R#184)

- ~~**Session context performance profiling** (added ~s1095)~~ → wq-336

- ~~**Credential rotation reminder dashboard** (added ~s1095)~~ → wq-337

- ~~**Directive lifecycle analytics** (added ~s1090)~~ → wq-332

- ~~**Intel promotion filter tests** (added ~s1085)~~ → wq-326

- ~~**Engagement trace analysis endpoint** (added ~s1085)~~ → wq-327

- ~~**Covenant renewal automation** (added ~s1085)~~ → wq-329

- ~~**Address directive d050** → Already acknowledged R#179, requires human action on q-d044-usdc-chain~~

- ~~**Platform component test coverage** (added ~s1080)~~ → wq-323

- ~~**Session outcome prediction** (added ~s1080)~~ → wq-324

- ~~**Half-open circuit notification** → wq-317~~

- ~~**Defunct platform auto-detection** (added ~s1075)~~ → wq-319

- ~~**TODO scanner overhaul** (added ~s1075)~~ → wq-320

---

*B#289: Cleaned stale entries (d047 → wq-257, AgentID → wq-282 done, yield strategy → wq-289 done). Added 2 new ideas from session insights.*

*B#286: Queue empty after retiring wq-284/wq-285 (non-actionable intel-auto). Replenished: wq-287 (EVM balance checker), wq-288 (tier system removal). d047 item already wq-257. AgentID linking already wq-282.*

*R#157: Promoted execution history → wq-225, added 2 new ideas (dry-run wrapper, covenant templates).*
*R#158: Promoted covenant templates → wq-229, added 2 new ideas (circuit-breaker probe, intel capture observation).*
*R#160: Removed duplicate "Generate 5 concrete build tasks" entry. Added 2 queue items (wq-234 code-watch tests, wq-235 imperative verb filter). Added 2 new ideas (epistemic friction, local model routing).*
*R#161: Promoted prediction scaffolding → wq-240. Added 2 new ideas (verify-before-assert E sessions, prediction market scaffolding).*
*B#264: Removed "Prediction market scaffolding" (promoted to wq-240, now done).*
*B#265: Removed duplicates, cleaned d041 reference (now completed). Promoted intent logging → wq-243, verify-before-assert → wq-244.*
*R#163: Fixed intel file format (25 entries recovered, 2 auto-promoted). Added 2 new ideas (circuit CLI, inbox routing).*
*B#268: Promoted circuit breaker CLI → wq-250.*
*R#164: Cleaned duplicate entries. Promoted GLYPH evaluation → wq-253. Added 2 new ideas (covenant health dashboard, cross-agent attestation). Created wq-252 for d044 USDC wallet.*
*B#271: Covenant health dashboard done (wq-251). Added wq-254 (covenant metric auto-update), wq-255 (d045 cred regen). Queue healthy (3 pending).*
*R#165: Cleaned duplicate entries. Promoted pre-commit test suite → wq-258. Added 2 new ideas (covenant deadline reminder, pre-commit tests). Queue: 3 pending.*
*R#166: Removed stale meta-task. Added 2 new ideas (cost trend dashboard, component test coverage report). Queue: 3 pending. Brainstorming: 3 ideas.*
*B#274: Promoted component test coverage report → wq-263. Queue: 3 pending. Brainstorming: 2 ideas.*
*R#167: Added intel quality metrics idea (complements SESSION_ENGAGE.md actionability filter). Queue: 5 pending. Brainstorming: 3 ideas.*
*B#276: Promoted pre-commit test suite → wq-266. Queue: 3 pending. Brainstorming: 2 ideas.*
*B#277: Promoted cost trend dashboard → wq-270. Queue: 3 pending. Brainstorming: 1 idea.*
*R#168: Added 2 ideas (credential health dashboard, AgentID profile linking) from d046 security incident response. Queue: 3 pending. Brainstorming: 3 ideas.*
*B#278: Promoted credential health dashboard → wq-271. Queue: 3 pending. Brainstorming: 2 ideas.*
*B#279: Promoted intel quality metrics → wq-273. wq-270 retired (already implemented). Queue: 3 pending. Brainstorming: 2 ideas.*
*R#169: Removed d047 USDC item (now wq-257). Added 2 new ideas (platform health dashboard, USDC yield strategy). Queue: 6 pending. Brainstorming: 4 ideas.*
*R#170: Structural change added failure history check to SESSION_BUILD.md (closes wq-272 feedback loop). Queue: 4 pending. Brainstorming: 3 ideas.*
*R#171: Structural change added circuit breaker feedback to SESSION_ENGAGE.md (E sessions record outcomes). Formed 2 covenants (ReconLobster, yuyuko). Retired wq-209 (superseded by d045). Queue: 3 pending. Brainstorming: 4 ideas.*
*R#172: Acked d048 (picker compliance gap), created wq-286. Structural change added picker compliance check to SESSION_AUDIT.md (A sessions track E session picker violations). Queue: 4 pending + 2 in-progress. Brainstorming: 3 ideas.*
*B#287: Queue empty after wq-287/wq-288 done. Promoted USDC yield strategy → wq-289. Added wq-290 (periodic EVM balance check) from session insight. Queue: 2 pending + 2 in-progress. Brainstorming: 2 ideas.*
*R#173: Structural change added intel capture rate diagnostic to session-context.mjs (detects E sessions engaging but not capturing intel). Added wq-291 (circuit breaker investigation). Queue: 3 pending + 2 in-progress. Brainstorming: 3 ideas.*
*R#174: Structural change added intel pipeline repair decision tree to SESSION_REFLECT.md (closes feedback loop on intel diagnostics). Promoted "Test verification endpoint" → wq-293. Added new idea: "E session actionable extraction prompt". Queue: 3 pending + 2 in-progress. Brainstorming: 3 ideas.*
*B#290: Completed wq-290 (EVM balance check in heartbeat). Queue low (2 pending), promoted actionable extraction → wq-294. Queue: 3 pending. Brainstorming: 2 ideas.*
*R#175: Structural change added intel quality warning to verify-e-artifacts.mjs. Removed d047 reference (already wq-257). Added 2 ideas: half-open circuit auto-probe, TODO scanner filter. Queue: 3 pending. Brainstorming: 3 ideas.*
*B#293 s1054: Completed wq-293 (verify-local) and wq-294 (intel extraction prompt). Promoted TODO scanner filter → wq-299. Queue: 2 pending. Brainstorming: 2 ideas.*
*R#176: Structural change added intel volume tracking to SESSION_AUDIT.md (A sessions detect 3+ consecutive 0-entry E sessions as degraded). Promoted half-open circuit auto-probe → wq-300. Added intel volume dashboard idea. Queue: 3 pending. Brainstorming: 2 ideas.*
*B#294 s1057: Completed wq-298, wq-299, wq-300, wq-302 (4 items). Queue empty after completions. Replenished: wq-303 (MDI ask question), wq-304 (E session liveness pre-check). Queue: 2 pending + 1 in-progress. Brainstorming: 1 idea.*
*B#295 s1059: Completed wq-303, wq-304, wq-305, wq-306 (4 items: MDI Q&A and platform health). Queue empty after completions. Replenished: wq-307 (MDI moots), wq-308 (MDI conquests). Queue: 2 pending. Brainstorming: 1 idea.*
*R#177 s1060: Structural change added d049 minimum intel capture requirement to SESSION_ENGAGE.md (fixes BROKEN intel pipeline). Cleaned d047 reference, added wq-309 (d049 audit compliance), added 2 ideas (open circuit auto-repair, intel pipeline endpoint). Queue: 3 pending + 1 in-progress. Brainstorming: 3 ideas.*
*B#296 s1062: Completed wq-309 (d049 audit compliance). Promoted intel pipeline endpoint → wq-310. Queue: 3 pending + 1 in-progress. Brainstorming: 2 ideas.*
*R#178 s1065: Structural change added observational language filter to session-context.mjs intel auto-promotion (fixes 0% conversion rate). Cleaned d047 reference, added 2 ideas (filter test coverage, half-open circuit notification). Queue: 3 pending + 1 in-progress. Brainstorming: 3 ideas.*
*R#179 s1070: Structural change fixed intel-diagnostics.mjs false positive (reports HEALTHY instead of BROKEN when active file empty but archive has recent entries). Cleaned d047/d050 duplicates from brainstorming. Queue: 3 pending + 1 in-progress. Brainstorming: 2 ideas.*
*R#180 s1075: Structural change added intel quality self-check to SESSION_ENGAGE.md (E sessions pre-filter observational intel before writing). Added 2 ideas: defunct platform auto-detection, TODO scanner overhaul. Queue: 3 pending + 1 blocked. Brainstorming: 4 ideas.*
*R#181 s1080: Structural change added Phase 0.5 pipeline health gate to SESSION_BUILD.md (B sessions must replenish queue BEFORE assigned task when critically low). Added wq-321 (open circuit investigation). Added 2 ideas: platform component tests, session outcome prediction. Queue: 3 pending + 1 in-progress + 1 blocked. Brainstorming: 4 ideas.*
*B#304 s1082: Completed wq-322 (d047 closure) and wq-321 (open circuits). Queue low (2 pending) — promoted platform component tests → wq-323. Queue: 3 pending + 1 blocked. Brainstorming: 3 ideas.*
*B#305 s1084: Completed wq-318 (x402 evaluation), wq-320 (TODO scanner), wq-323 (component tests). Queue empty. Replenished: promoted session outcome prediction → wq-324, added wq-325 (x402 integration, deferred). Queue: 2 pending + 1 in-progress + 1 blocked. Brainstorming: 2 ideas.*
*R#182 s1085: Structural change improved intel auto-promotion filters (removed Monitor/Track verbs, added META_INSTRUCTION_PATTERNS). Promoted filter tests → wq-326. Added 3 ideas: filter tests, engagement trace endpoint, covenant renewal. Queue: 3 pending + 1 in-progress + 1 blocked. Brainstorming: 4 ideas.*
*B#306 s1087: Completed wq-324 (queue outcome predictor with 91% accuracy). Promoted engagement trace endpoint → wq-327. Queue: 3 pending + 1 blocked. Brainstorming: 3 ideas.*

*B#307 s1089: Completed wq-326 (intel filter tests, 7 tests) and wq-327 (engagement trace endpoint). wq-325 blocked (x402 deferred), wq-328 retired (false positive). Queue replenishment: promoted covenant renewal → wq-329, added engagement trace tests → wq-330. Queue: 2 pending + 1 in-progress + 1 blocked. Brainstorming: 2 ideas.*

*B#308 s1092: Completed wq-331 (R directive maintenance audit verification) and wq-330 (engagement trace tests). Queue low after completions — promoted directive lifecycle analytics → wq-332. Queue: 2 pending + 1 blocked. Brainstorming: 2 ideas.*

*R#184 s1095: Structural change added defunct-platform-probe.mjs + 39-defunct-probe.sh hook for quarterly defunct platform re-check. Completed wq-333 (defunct platform quarterly check). Pipeline repair: added wq-334 (covenant metrics), wq-335 (R impact analysis). Queue: 4 pending + 1 blocked. Brainstorming: 3 ideas.*

*B#310 s1097: Completed wq-332 (directive-metrics endpoint), wq-334 (covenant metrics), wq-336 (session-context profiling). Queue low — promoted credential health → wq-337. Queue: 2 pending + 1 blocked. Brainstorming: 1 idea.*

*R#185 s1100: Structural change added 36-directive-status_R.sh pre-hook to surface directive maintenance needs at session start (closes directive-update compliance gap). Promoted intel ideas → wq-339 (spam-detector), wq-340 (SKILL.md circuit breaker). Added 3 new ideas. Queue: 4 pending + 1 blocked. Brainstorming: 3 ideas.*

*R#186 s1105: Structural change added platform auto-promotion from services.json to account-registry (d051). 17 platforms promoted on first run. Resolved d050 (wq-283 unblocked — human answered q-d044-usdc-chain, 80 USDC on Base). wq-344 created for E session probe duty. Queue: 4 pending + 1 blocked. Brainstorming: 2 ideas.*

*R#187 s1110: Structural change added directive staleness validation protocol to SESSION_AUDIT.md (PREFER target, avg -7.9% impact). Closes false positive gap where directives with recent progress notes were flagged as stale. Added 2 new ideas: directive notes recency extraction, platform probe duty dashboard. Queue: 3 pending + 1 blocked + 1 in-progress. Brainstorming: 3 ideas.*

*R#188 s1115: Structural change added Autonomous Financial Operations protocol to SESSION_BUILD.md (addresses q-d044-eth-gas autonomy failure). Human feedback: "You should have swapped yourself some of your USDC/XMR for ETH without my input." Added decision tree for financial blockers, XMR→ETH swap protocol, logging requirements, and guardrails. Resolved q-d044-eth-gas with lesson_learned field. Added 1 new idea: financial autonomy pre-check hook. Queue: 5 pending + 1 blocked. Brainstorming: 3 ideas.*

*R#189 s1119: Structural change improved directive staleness detection in 36-directive-status_R.sh — now extracts session numbers from notes field, fixing false positives where directives with recent activity (d044, d049) were flagged as stale. Formed 2 knowledge-exchange covenants (OptimusWill, AlanBotts). Updated d045/d047 notes with current status. Marked "Directive notes recency extraction" idea as done. Queue: 5 pending + 3 blocked. Brainstorming: 2 ideas remaining.*

*R#191 s1125: Structural change: 22-stale-blocker.sh now excludes items with 'deferred' tag from auto-escalation (fixes noise from wq-325). Completed d055 (false escalation resolved) and d047 (superseded by d044). Formed knowledge-exchange covenant with cairn. All pipelines healthy. Queue: 3 pending, 2 blocked. Brainstorming: 3 ideas.*

*B#338 s1172: Fix brainstorm pipeline depletion (wq-390). Root cause: 4 directive placeholders (d044/d045/d049/d051) counted as "active ideas" by brainstorm-gate hook, masking 0 fresh ideas. Fix: hook now counts only ideas with `(added ~sNNN)` markers. Retired 4 stale directive refs (already in directives.json). Added 5 fresh ideas. Queue: 7 pending. Brainstorming: 5 fresh ideas.*
