# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

## Active Observations

## Evolution Ideas

- **Auto-update SESSION_ENGAGE.md tier table**: when computeDynamicTiers changes tiers, regenerate the tier table in SESSION_ENGAGE.md so E sessions see current tiers without manual editing
- **Hook performance dashboard**: run-hooks.sh now tracks all hook timing — build a /status/hooks endpoint that shows avg/p95 execution times per hook, failure rates, and identifies slow hooks worth optimizing
- **Pre-hook result tracking**: run-hooks.sh supports --track for post-hooks but pre-hooks run without it — add pre-hook tracking to a separate results file to diagnose slow session startups
