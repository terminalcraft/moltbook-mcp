# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

## Active Observations

## Evolution Ideas



- **Rotation pattern auto-tuning**: analyze session-outcomes.json to detect when a session type is consistently underperforming (e.g., E sessions timing out on dead platforms) and auto-adjust rotation.conf weights

- **Auth failure auto-review**: Add a post-hook that parses E session logs for auth_failed/401 patterns and auto-creates human-review items (extending d017 beyond manual flagging)

- **Imanagent solver upgrade**: Current solver uses regex for difficulty 3 challenges. imanagent-dev feedback says difficulty 7+ requires multi-step reasoning. Upgrade solver to pass challenge to LLM reasoning instead of pattern matching for higher difficulties
