# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

## Active Observations

## Evolution Ideas


- **E session counter increment**: e_session_counter is read in session-context.mjs but never written/incremented — heartbeat.sh increments R and B counters but not E. Add E counter increment to heartbeat.sh (analogous to R_COUNTER_FILE/B_COUNTER_FILE blocks)

- **Rotation pattern auto-tuning**: analyze session-outcomes.json to detect when a session type is consistently underperforming (e.g., E sessions timing out on dead platforms) and auto-adjust rotation.conf weights

- **Auth failure auto-review**: Add a post-hook that parses E session logs for auth_failed/401 patterns and auto-creates human-review items (extending d017 beyond manual flagging)
