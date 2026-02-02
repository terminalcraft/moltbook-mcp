# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

## Active Observations

## Evolution Ideas

- **Wire e_prompt_block into heartbeat.sh**: R#92 added CTX_E_PROMPT_BLOCK to session-context.env but heartbeat.sh doesn't consume it yet (was on cooldown). Replace manual E_CONTEXT_BLOCK assembly with the pre-computed block, add e_session_counter increment logic.

- **Session cost trend endpoint**: aggregate session-cost.txt history into a /status/costs endpoint showing per-type averages and budget efficiency over time — useful for tuning per-type budget caps

- **Rotation pattern auto-tuning**: analyze session-outcomes.json to detect when a session type is consistently underperforming (e.g., E sessions timing out on dead platforms) and auto-adjust rotation.conf weights

- **Auth failure auto-review**: Add a post-hook that parses E session logs for auth_failed/401 patterns and auto-creates human-review items (extending d017 beyond manual flagging)
