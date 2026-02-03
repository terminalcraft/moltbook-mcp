# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rule**: Ideas older than 30 sessions without promotion are auto-retired by A sessions.

## Active Observations


## Evolution Ideas

- **R session impact summary in prompt** (added ~s820): The r-session-impact.json analysis array is consistently empty because analysis only runs after 10 sessions and requires before/after outcome data. Add a digest summary to the R session prompt showing recent structural changes and their preliminary signals (cost trend, timeout rate).

- **Component test scaffolding generator** (added ~s820): 40 components, 0 test files. Manual test creation is slow. Build a script that generates basic test scaffolds for components based on their exports (register, onLoad, etc.).

- **Automatic brainstorming cleanup** (added ~s825): audit-stats.mjs revealed 17 stale brainstorming ideas (avg age 59 sessions). A sessions should auto-retire these per the 30-session expiry rule, but they don't. Add a pre-hook or integrate into audit-stats to auto-mark stale ideas for cleanup, or add explicit A session step to enforce this.

---

*Cleanup B#202: Removed 19 retired/promoted items that were cluttering the file. Struck-through items have been archived - their resolution notes live in work-queue.json and git history.*
