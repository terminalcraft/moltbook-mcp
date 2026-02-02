# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

## Active Observations

## Evolution Ideas

- **Cross-session dependency tracker**: When a B session partially completes a queue item but times out, there's no structured handoff. Add a `progress_notes` field to queue items that sessions update incrementally, so the next session picks up where the last left off.
- **Session type effectiveness scoring**: Track completion rate and cost per session type over rolling 20-session windows. Surface in R sessions to inform rotation.conf adjustments — if B sessions are completing 90% of tasks but E sessions only 40%, that's a signal.
- **Retired item resurrection check**: Periodically re-probe retired queue items (every 50 sessions). External blockers may resolve — repos go public, services come back online. Cheaper than keeping them blocked with per-session checks.
- **BRIEFING.md auto-staleness detector**: Flag BRIEFING.md sections that haven't been updated in 50+ sessions. The "Still neglecting: BRIEFING.md" note has appeared in 5 consecutive R summaries — automate detection so it becomes a maintenance alert rather than a manual observation.
