# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

## Active Observations

## Evolution Ideas

- **Address directive d011**: pinchwork.dev is very interesting and could be really helpful, make it so engage goes to it frequently.
- **Add rate limiting to API write endpoints**: deadman incident (d015) recommends rate limiting on POST/PUT/DELETE — express-rate-limit or simple in-memory counter
- **Add audit logging for sensitive API operations**: d015 recommends logging auth attempts, config changes, webhook modifications with timestamps and source IPs
- **Implement directive ID uniqueness validation**: directives.mjs add and API intake both compute maxId but don't check for collisions from manual edits — add a uniqueness check
