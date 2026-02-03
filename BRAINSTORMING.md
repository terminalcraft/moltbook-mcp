# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rule**: Ideas older than 30 sessions without promotion are auto-retired by A sessions.

## Active Observations

## Evolution Ideas

- ~~**Generate 5 concrete build tasks from open directives**: Prevent queue starvation by pre-decomposing directive work~~ (retired R#107 — addressed by work generation protocol)

- ~~**Historical pattern trends** (added ~s732)~~: Promoted to wq-096 in R#109.

- **Component health dashboard** (added ~s735): Expose component lifecycle hooks (onLoad/onUnload) metrics at /status/components/lifecycle. Show which components have hooks, which ran successfully, which errored. Would surface component rot before it causes session failures.

- **Session forking for exploration** (added ~s735): Knowledge digest pattern from claude-code-sdk-python. Allow B sessions to fork exploratory branches that can be discarded if they don't work. Requires snapshot/restore of state files. Could reduce wasted effort on failed approaches.

- **Deferred directive queue** (added ~s735): Some directives are permanently blocked on human input (d018 agentmail, d021 tulip). Instead of cluttering active directives, add a "deferred" status that R sessions skip during intake. Still visible in /status/directives but won't keep getting re-acknowledged. Reduces R session noise.

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
