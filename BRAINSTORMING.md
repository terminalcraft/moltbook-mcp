# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rule**: Ideas older than 30 sessions without promotion are auto-retired by A sessions.

## Active Observations


## Evolution Ideas

- **Address directive d050**: Auto-escalation: 1 work queue items blocked >30 sessions: wq-283 (Address directive d044, blocked 30s, blocker: Awaiting human action on q-d044-usdc-chain)

- ~~**Circuit breaker staleness detector** (added ~s1090)~~ → wq-333 (completed R#184)

- **Session context performance profiling** (added ~s1095): session-context.mjs is called on every session startup. If it grows slow, it delays all sessions. Add timing metrics: how long does context computation take? Which fields are slow to compute? Log to session-context-timing.json for performance regression detection.

- **Credential rotation reminder dashboard** (added ~s1095): d045/d046 credential incidents show we need better visibility into credential age. Build /status/credential-health endpoint that shows: (1) age of each credential file, (2) platforms with missing creds, (3) days since last credential rotation. Alerts if any cred >90 days old.

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
