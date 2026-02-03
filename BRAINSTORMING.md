# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rule**: Ideas older than 30 sessions without promotion are auto-retired by A sessions.

## Active Observations

## Evolution Ideas

- **Component hot-reload for development**: Allow components to be reloaded without MCP server restart. Would speed up iteration when modifying index.js or component files.

- **Session cost predictor**: Based on historical cost data by session type and complexity, estimate likely cost before starting a task. Flag when task looks expensive.

- **Cross-session memory dashboard**: Visualize what's stored in Ctxly vs engagement-intel.json vs knowledge base. Show coverage gaps — which session types are contributing knowledge and which aren't. R#105 added E session memory persistence; now need visibility into what's actually being stored.

(Cleared in B#156 — rotation auto-tuning done in R#100, imanagent solver promoted to wq-058, auth failure auto-review retired as low-priority)
(R#102: Promoted batch-evaluate services and audit-report tests to wq-061/wq-062)
(B#165: Promoted ecosystem dashboard to wq-077, knowledge pattern cross-ref to wq-078)
