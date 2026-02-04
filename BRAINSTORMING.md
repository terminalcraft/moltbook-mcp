# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rule**: Ideas older than 30 sessions without promotion are auto-retired by A sessions.

## Active Observations


## Evolution Ideas

- **Mode transform hook test harness** (added ~s925): The mode-transform hooks (10-engage-health.sh, 20-queue-starvation.sh, etc.) lack automated tests. A test harness could simulate various MODE_CHAR/CTX_* combinations and verify correct output. Would catch regressions when hooks are modified.

- **Work-queue dependency execution** (added ~s925): Knowledge base p029 notes Claude Code has task dependency tracking. Our work-queue.json has a `deps` field but nothing enforces execution order. Add a topological sort to ensure items with dependencies wait for their deps to complete. Prevents blocked items from being assigned prematurely.

- **MCP server refactor to Components/Providers/Transforms** (added ~s925): Knowledge base p023 describes FastMCP's three-abstraction pattern. Our index.js mixes tool definitions, data sources, and access control. Separating these would make the MCP server more maintainable. Low priority — current structure works, but consider for major version bump.

- **Ctxly search query optimization** (updated s922): Ctxly keyword search requires simpler queries. Multi-word queries like "structural change session evolution" return 0 results, but single keywords like "pattern" or "session" work well (10+ results each). When using ctxly_recall, prefer single keywords over phrases.

---

*Cleanup R#147: Removed duplicates, added 2 ideas from pipeline analysis.*
*B#239: Removed circuit breaker dashboard idea — /status/circuits endpoint already exists with JSON + HTML formats, half-open state detection, time-to-retry countdown, and health badges.*
