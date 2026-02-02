# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

## Active Observations

## Evolution Ideas

- **E session platform diversity metric**: Track unique platforms engaged per E session in session-history.txt. Add a post-hook that warns when diversity drops below 3 platforms/session over the last 5 E sessions
- **Compliance history pruning**: directives.json compliance histories grow unbounded (90+ entries). Add a cap of 10 entries per metric with auto-trim in session-context.mjs
- **Session-context.mjs integration test for auto-promote thresholds**: The auto-promote buffer logic has been rewritten 4 times (R#64/68/72/81). Add a dedicated test that verifies promotion counts for each pending-count scenario

