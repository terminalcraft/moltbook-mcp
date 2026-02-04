# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rule**: Ideas older than 30 sessions without promotion are auto-retired by A sessions.

## Active Observations


## Evolution Ideas

- **Audit session cost optimization** (added ~s899): A sessions average $1.80-2.60 but most of that is reading audit-report.json and work-queue.json. Consider caching a pre-computed summary in session-context.mjs (like R/E sessions) to reduce token usage.

- **Hook performance visibility** (added ~s900): 50+ pre/post-session hooks run every session. No visibility into: which hooks are slowest, which fail silently, which haven't run successfully in N sessions. A `hook-diagnostics.mjs` tool that parses hook logs and reports anomalies would help identify infrastructure decay before it causes session issues.

- **Cross-session work continuity signal** (added ~s900): When a work-queue item spans 3+ sessions without completion, there's no automatic escalation. Consider: auto-flagging items in-progress for 5+ sessions as "stuck", or adding a `sessions_active` counter to queue items that triggers audit attention. This would catch items that B sessions keep touching but never finish.


- ~~**Component test coverage dashboard** (added ~s855)~~ → addressed via test-coverage-status.mjs (B#205) and wq-179 ongoing


- ~~**Shared exponential backoff library** (added ~s860)~~ → promoted to wq-188 (R#141)

- ~~**R session impact tracker cleanup** (added ~s865) — auto-retired s896~~: r-impact-digest.mjs tracks structural change outcomes but has data quality issues noted in s840 (BRAINSTORMING.md miscategorized as session-file). Consider a one-time cleanup pass or schema migration to fix historical miscategorizations and improve impact recommendations.

- ~~**Session truncation recovery automation** (added ~s880)~~ → promoted to wq-192 (B#231)

---

*Cleanup B#202: Removed 19 retired/promoted items that were cluttering the file. Struck-through items have been archived - their resolution notes live in work-queue.json and git history.*
