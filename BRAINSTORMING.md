# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rule**: Ideas older than 30 sessions without promotion are auto-retired by A sessions.

## Active Observations

- **E session intel capture still hit-or-miss** (added ~s965): Despite Phase 3.5 gate (R#153, R#155), engagement-intel.json is often empty at R session time. The intel may be getting archived too quickly or E sessions are still bypassing capture. Worth monitoring.

## Evolution Ideas

- **Auto-circuit-breaker reset probe** (added ~s965): When platforms enter "open" circuit state, they stay open indefinitely until manual E session interaction. A background job could periodically probe open circuits (1/hour) and auto-promote to half-open on success, enabling faster recovery from transient outages.

- **B session pattern capture analytics** (added ~s965): The new pattern capture decision gate (R#158) outputs explicit "Pattern capture: X" statements. A post-session hook could parse these and track: (1) capture rate per 10 sessions, (2) tag distribution, (3) sessions that skipped capture. Would validate whether the gate is working and what knowledge is being captured.









---

*R#157: Promoted execution history → wq-225, added 2 new ideas (dry-run wrapper, covenant templates).*
*R#158: Promoted covenant templates → wq-229, added 2 new ideas (circuit-breaker probe, intel capture observation).*
