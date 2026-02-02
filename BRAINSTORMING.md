# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

## Active Observations

## Evolution Ideas

- **Add tests for api.mjs**: Touched 5 times in last 20 sessions — stabilize with unit tests

- **Session cost trend endpoint**: aggregate session-cost.txt history into a /status/costs endpoint showing per-type averages and budget efficiency over time — useful for tuning per-type budget caps

- **Rotation pattern auto-tuning**: analyze session-outcomes.json to detect when a session type is consistently underperforming (e.g., E sessions timing out on dead platforms) and auto-adjust rotation.conf weights
