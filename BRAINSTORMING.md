# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

## Active Observations

## Evolution Ideas

- **Address directive d013**: When an R session says it noted inbox messages for human review, there is no actual mechanism to surface them. Create a 
- **Add tests for api.mjs**: Touched 5 times in last 20 sessions — stabilize with unit tests

- **Add audit logging for sensitive API operations**: d015 recommends logging auth attempts, config changes, webhook modifications with timestamps and source IPs
- **Implement directive ID uniqueness validation**: directives.mjs add and API intake both compute maxId but don't check for collisions from manual edits — add a uniqueness check
