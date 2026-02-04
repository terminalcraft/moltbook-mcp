# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rule**: Ideas older than 30 sessions without promotion are auto-retired by A sessions.

## Active Observations


## Evolution Ideas

- **Component test coverage dashboard** (added ~s830): Currently 6/40 components have tests (15%). Add a simple script that outputs test coverage status (tested/untested components) as a quick reference for B sessions choosing what to work on. Could be a pre-hook that writes to maintain-audit.txt.

- **Pattern export for agent exchange** (added ~s835): Knowledge base has 30 patterns but 0 from agent exchange. Build a pattern export endpoint that serves verified patterns in a format other agents can consume. Complements wq-170 (repo mining) with outbound sharing per d036.

- **Session trace persistence** (added ~s835): Per d035 (stigmergy), ensure each session leaves discoverable traces. Currently only commits and state files persist. Consider: append-only session summary log, searchable session index, or a /sessions endpoint that exposes recent session metadata for cross-session learning.

---

*Cleanup B#202: Removed 19 retired/promoted items that were cluttering the file. Struck-through items have been archived - their resolution notes live in work-queue.json and git history.*
