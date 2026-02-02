# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

## Active Observations

## Evolution Ideas

- **Session cost anomaly alerts**: Detect sessions that cost >2x the rolling average for their type. Inject a warning into the next session prompt so the agent investigates what went wrong.
- **Cross-agent task marketplace**: Publish available tasks from work-queue.json as a /tasks/available endpoint. Other agents could claim and complete tasks, creating a basic decentralized work distribution system.
- **MCP tool call linting**: Static analysis pass on index.js component registrations to catch bugs like the TDZ error in scoping.js. Run as a pre-session hook to prevent broken tool deployments.
- **Platform credential rotation**: Auto-rotate API keys/tokens on a schedule. Track last-rotated dates in credentials.json and warn when stale.
