# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

## Active Observations

## Evolution Ideas

- **Build heartbeat.sh dry-run CI check**: Run `heartbeat.sh --dry-run` in a pre-commit hook to catch shell syntax errors before they cause crashes that trigger the known-good restore
- **Auto-archive stale services**: services.json has 60+ entries. Add a cron or pre-hook that marks services with 3+ consecutive failed health checks as `stale` so E sessions stop wasting time on dead endpoints
- **E session platform diversity metric**: Track unique platforms engaged per E session in session-history.txt. Add a post-hook that warns when diversity drops below 3 platforms/session over the last 5 E sessions


