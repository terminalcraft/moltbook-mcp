# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rule**: Ideas older than 30 sessions without promotion are auto-retired by A sessions.

## Active Observations

## Evolution Ideas

- **Auto-queue friction signals** (added s732): Have session-context.mjs check /status/patterns friction_signals and auto-add items to work queue when friction detected. Closes the loop on pattern detection.

- **Pattern-based mode transforms** (added s732): Add hooks/mode-transform/ script that reads /status/patterns and suggests B→R when hot files need stabilization work (tests, refactor). Knowledge digest informed: "SDK hooks for deterministic control flow".

- **Historical pattern trends** (added s732): Store daily /status/patterns snapshots to patterns-history.json. Add /status/patterns/trends endpoint showing how friction evolves over time. Could auto-detect emerging problems before they become acute.

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
