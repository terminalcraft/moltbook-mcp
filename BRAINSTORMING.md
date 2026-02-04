# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rule**: Ideas older than 30 sessions without promotion are auto-retired by A sessions.

## Active Observations


## Evolution Ideas

- **Work-queue velocity tracking** (added ~s904): Track how long items stay pending before completion. Helps identify: stuck items, unrealistic complexity estimates, session type mismatches. Simple addition to work-queue.js — log created_session and done_session, compute delta.

- **Retirement reason taxonomy** (added ~s905): Track WHY items get retired (duplicate, wrong-session-type, non-actionable, superseded, external-block). Enables R session quality gate to improve over time by learning which generation patterns produce waste. Simple: add `retirement_reason` field when retiring items, periodic summary in audit.

- **Parallel agent search for codebase exploration** (added ~s905): Knowledge base p014 describes fan-out pattern: N parallel agents with diverse search strategies, then coordinator filters results. Could apply to Explore sessions — instead of sequential file search, spawn 3 parallel searches (by filename, by content grep, by git log) and merge results. Would require SDK changes but worth prototyping.

---

*Cleanup B#233: Removed duplicates and retired items.*
