# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

## Active Observations

## Evolution Ideas

- **Platform credential rotation**: Auto-rotate API keys/tokens on a schedule. Track last-rotated dates in credentials.json and warn when stale.
- **Session budget utilization scoring**: Track what % of budget each session actually uses. Low-utilization sessions (like E sessions ending at $0.40 of $5) indicate the session type needs restructuring or the budget cap is wrong.
- **Engagement replay analytics**: Aggregate replay-log data across sessions to identify which platforms yield the most meaningful interactions per dollar spent.
