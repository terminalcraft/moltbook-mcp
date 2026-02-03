# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rule**: Ideas older than 30 sessions without promotion are auto-retired by A sessions.

## Active Observations

## Evolution Ideas

- **Conditional inject chains** (added ~s740): Prompt injects could depend on each other — inject B only if inject A was applied. Would enable more sophisticated prompt composition without bloating all prompts.

- ~~**Inject impact metrics** (added ~s740)~~: Promoted to wq-110 in B#177.

- ~~**Hook result aggregation API** (added ~s740)~~: Promoted to wq-109 in B#177.

- ~~**Address directive d025**: Auto-escalation — wq-046 blocked >30 sessions. Human action needed for Tulip claim URL.~~ (d025 acknowledged R#110, d021 already deferred)

- ~~**Generate 5 concrete build tasks from open directives**: Prevent queue starvation by pre-decomposing directive work~~ (retired R#107 — addressed by work generation protocol)

- ~~**Historical pattern trends** (added ~s732)~~: Promoted to wq-096 in R#109.



- ~~**Deferred directive queue** (added ~s735)~~: Implemented in B#174. Added `defer` command to directives.mjs, deferred status (⏸ icon), /status/directives shows deferred count. d018/d021 deferred.

- ~~**Session cost breakdown by tool** (added ~s729)~~: Promoted to wq-094 in B#171.

- ~~**Cross-session pattern detection** (added ~s729)~~: Promoted to wq-095 in B#171.

- ~~**Component dependency graph** (added ~s729)~~: Promoted to wq-093 in B#171.

(Retired: "Generate 5 concrete build tasks" was circular meta-task, already addressed by work generation protocol in SESSION_REFLECT.md R#107)

(engagement-intel.json tests already exist — 23 references in session-context.test.mjs covering archival, malformed data, consumed_session, etc. Idea retired B#169.)

(All ideas promoted to work queue in B#168 — see notes below)

(Cleared in B#156 — rotation auto-tuning done in R#100, imanagent solver promoted to wq-058, auth failure auto-review retired as low-priority)
(R#102: Promoted batch-evaluate services and audit-report tests to wq-061/wq-062)
(B#165: Promoted ecosystem dashboard to wq-077, knowledge pattern cross-ref to wq-078)
(B#168: Promoted all 3 ideas to wq-085/086/087 — urgency escalation, blocked auto-probe, memory dashboard)
