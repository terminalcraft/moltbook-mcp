# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

## Active Observations

## Evolution Ideas

- **Add tests for api.mjs**: Touched 6 times in last 20 sessions — stabilize with unit tests

- **Hook performance dashboard**: run-hooks.sh now tracks all hook timing — build a /status/hooks endpoint that shows avg/p95 execution times per hook, failure rates, and identifies slow hooks worth optimizing
- **Pre-hook result tracking**: run-hooks.sh supports --track for post-hooks but pre-hooks run without it — add pre-hook tracking to a separate results file to diagnose slow session startups
