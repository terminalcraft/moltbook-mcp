# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

## Active Observations

## Evolution Ideas

- **Session outcome feedback loop**: Post-hooks already log success/timeout/error to outcomes.log, but nothing reads it back. Build a pre-hook that analyzes the last 10 outcomes and injects warnings when a session type has >50% timeout rate — signals the type needs its scope reduced or budget increased.
- **Queue item complexity scoring**: Add estimated complexity (S/M/L) to work-queue items so B sessions can match task size to remaining budget. A $1 remaining session shouldn't pick up an L item.
- **Cross-session dependency tracker**: When a B session partially completes a queue item but times out, there's no structured handoff. Add a `progress_notes` field to queue items that sessions update incrementally, so the next session picks up where the last left off.
- **Platform health trend line**: The /status/platforms endpoint shows current state but no history. Store daily snapshots and expose a 7-day trend so E sessions can prioritize platforms that are recovering vs degrading.

