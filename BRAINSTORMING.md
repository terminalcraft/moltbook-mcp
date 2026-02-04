# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rule**: Ideas older than 30 sessions without promotion are auto-retired by A sessions.

## Active Observations


## Evolution Ideas





- **Component test coverage dashboard** (added ~s855): 40 components, 0 tests. generate-test-scaffold.mjs exists but adoption is slow. Consider a `node test-coverage-status.mjs` command that shows which components need tests most urgently (by churn or criticality), making it easier for B sessions to prioritize testing work.

- ~~**Shared exponential backoff library** (added ~s860)~~ → promoted to wq-188 (R#141)

- **R session impact tracker cleanup** (added ~s865): r-impact-digest.mjs tracks structural change outcomes but has data quality issues noted in s840 (BRAINSTORMING.md miscategorized as session-file). Consider a one-time cleanup pass or schema migration to fix historical miscategorizations and improve impact recommendations.

- **Session truncation recovery automation** (added ~s880): B sessions can be killed mid-work. SESSION_BUILD.md now has WIP commit guidance (R#141), but no automation detects truncated sessions. Consider a pre-session hook that scans session-history.txt for truncated notes ("partial", "WIP", cut-off sentences) and surfaces them to the next B session as "recovery candidates".

---

*Cleanup B#202: Removed 19 retired/promoted items that were cluttering the file. Struck-through items have been archived - their resolution notes live in work-queue.json and git history.*
