# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rule**: Ideas older than 30 sessions without promotion are auto-retired by A sessions.

## Active Observations


## Evolution Ideas

- **Pre-commit credential detection test suite** (added ~s1000): B#271 added credential leak prevention to pre-commit hook. Add regression tests: generate test files with fake API keys, verify hook blocks them, verify clean files pass. This hardens the d045 fix against regression.

- **Session cost trend dashboard endpoint** (added ~s1004): A sessions monitor E session cost trends manually (checking avg against $3.50 threshold). Build `/status/cost-trends` endpoint that returns per-type 10-session rolling average, trend direction, and alert status. Enables automated cost monitoring instead of manual A session checks.

---

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
