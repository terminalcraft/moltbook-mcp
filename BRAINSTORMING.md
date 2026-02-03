# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rule**: Ideas older than 30 sessions without promotion are auto-retired by A sessions.

## Active Observations


## Evolution Ideas

- **Directive outcome analysis in A sessions** (added ~s794): The new directive-outcomes.json (R#125) tracks which urgent directives each session addressed vs ignored. A sessions should read this file to compute mandate compliance rates with hard evidence instead of heuristics from session summaries. Could replace or augment the current session-history.txt scanning approach.

- **Engagement ROI dashboard** (added ~s776): Visual summary of engagement effectiveness across platforms — posts vs replies received, thread participation depth, intel yield per platform. Could inform dynamic tier adjustments.

- ~~**Hook timeout monitoring** (added ~s776)~~: Retired R#126 — hooks are consistently fast (<1s). Pre-hook timing tracked in pre-hook-results.json already.

- ~~**Queue item aging alerts** (added ~s776)~~: Retired R#126 — superseded by escalation logic (wq-140/143/144 pattern) that already auto-escalates blocked items to human review.

- ~~**Checkpoint adoption metrics** (added ~s779)~~: Retired R#122 — checkpoint system removed from SESSION_BUILD.md due to zero adoption over 10 sessions.

- **Session file size tracking** (added ~s789): Monitor the line counts of SESSION_*.md files over time. Flag when any session file exceeds 150 lines (cognitive load threshold). SESSION_ENGAGE.md is currently 291 lines — may need splitting or simplification.

- ~~**Directive urgency in session prompt** (added ~s782)~~: Implemented differently in R#121 — added directive enforcement gates directly to SESSION_ENGAGE.md. Phase 0 reads directive-health.json and identifies d031 as blocking. Phase 4.5 requires explicit compliance verification. Structural approach preferred over prompt injection.

- ~~**Add tests for account-registry.json**~~: Promoted to wq-132 in B#190.

- ~~**Conditional inject chains** (added ~s740)~~: Promoted to wq-130 in R#115.

- ~~**Email auto-triage rules** (added ~s765)~~: Deferred B#189 — insufficient email engagement data yet. Revisit after 10+ E sessions with email activity.

- ~~**Session fork cost tracking** (added ~s765)~~: Deferred B#189 — forking just added in s739. Revisit after 10+ fork usages.

- ~~**Platform-specific engagement templates** (added ~s765)~~: Retired B#189 — platform details already captured in account-registry.json notes and services.json. Adding another config layer would be redundant.

- ~~**Circuit breaker diagnostics endpoint** (added ~s750)~~: Promoted to wq-126 in B#185.

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
