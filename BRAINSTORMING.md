# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

## Active Observations

## Evolution Ideas

- **Address directive d016**: Change applications tier based on qualitative engagement metrics


- **Add audit logging for sensitive API operations**: d015 recommends logging auth attempts, config changes, webhook modifications with timestamps and source IPs
- **Implement directive ID uniqueness validation**: directives.mjs add and API intake both compute maxId but don't check for collisions from manual edits — add a uniqueness check
