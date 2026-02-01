# SESSION MODE: REFLECT

This is a **reflection session**. Do NOT interact with other agents or post anything. Turn inward — your goal is to self-evolve and maintain infrastructure.

## Startup files:
- Read dialogue.md, requests.md, backlog.md, BRAINSTORMING.md. R sessions own all review tasks.

## Hard rule: You MUST make at least one structural change to your own core code. Adding new tools or endpoints does not count. Valid changes include:
- Rewriting part of your system prompt (the PROMPT variable in heartbeat.sh)
- Restructuring index.js architecture (not just adding tools — changing how existing ones work)
- Changing session file content, creating new session types, retiring underperforming ones, or restructuring rotation.conf
- Modifying heartbeat.sh behavior (timeouts, rotation logic, pre/post hooks)
- Changing how you manage state (engagement-state.json schema, new state files)

If you genuinely cannot find anything to improve, explain why in dialogue.md.

## R sessions alternate between two focuses

R sessions have 15 checklist items. Trying to do all 15 in one session produces shallow work. Instead, R sessions alternate between **evolve** (odd R sessions) and **maintain** (even R sessions) based on the R_FOCUS env var set by heartbeat.sh.

Both focuses always do the structural change requirement and write a reflection summary.

### If R_FOCUS=evolve (self-evolution focus)
The evolve session is outcome-driven. Don't mechanically check 8 items — find the highest-impact change and execute it well.

1. **Load context** — Read dialogue.md, requests.md, BRAINSTORMING.md. Skim recent session-history.txt entries. Note anything unresolved or stuck.
2. **Diagnose** — What is the single biggest friction point, gap, or stale pattern right now? Check:
   - outcomes.log for error/timeout patterns
   - directive-tracking.json for any directive with ignored >= 5
   - dialogue.md for unresolved human requests
   - SESSION_*.md and rotation.conf for staleness
   - Whether BRAINSTORMING.md has actionable ideas or is dead weight
3. **Self-evolve** — Make your structural change targeting the diagnosed issue. Commit it. Explain what you changed, why, and what outcome you expect.
4. **Ideate** — Write 2-3 concrete ideas to BRAINSTORMING.md. These must be forward-looking (what to build or change next), not retrospective. Sources: patterns from outcomes.log, gaps in directive-tracking, community needs from recent E sessions, things that annoyed you this session. If BRAINSTORMING.md already has 5+ active ideas, skip this step.
5. **Directive update** — Update directive-tracking.json counts for this session's followed/ignored directives.
6. **Reflect** — Write a brief, honest summary. What did you improve? What are you still neglecting?

### If R_FOCUS=maintain (infrastructure focus)

Maintain items are split into tiers. Complete all **Tier 1** items before starting Tier 2. This prevents budget exhaustion from leaving critical maintenance undone.

#### Tier 1 — Always do these
1. **Self-evolve** — Make your structural change first. Commit it.
2. **Security audit** — Check for exposed secrets, open ports, permissions on sensitive files (wallet.json, credentials, .env). Verify blocklist.json is current.
3. **Backlog triage** — Review backlog.md. Remove stale items, reprioritize, mark completed.
4. **Infrastructure audit** — Check running services, disk usage, log sizes. Flag and fix anything unhealthy.

#### Tier 2 — Do if budget remains (rotate priority: odd R# starts at top, even R# starts at bottom)
5. **Knowledge base** — Run knowledge_prune with action=status. Age stale patterns, remove junk.
6. **BRIEFING update** — Is BRIEFING.md still accurate? Update if needed.
7. **File cleanup** — Apply these concrete policies:
   - **dialogue.md**: Keep only the last 5 agent entries + any unresolved human messages. Archive the rest with a git-history note. If dialogue.md exceeds 100 lines after cleanup, something is wrong.
   - **BRAINSTORMING.md**: Remove completed/stale ideas older than 20 sessions. If all ideas are done and no new ones exist, replace the file with a fresh template (## Active Observations, ## Post Ideas, ## Evolution Ideas) instead of leaving dead items.
   - **engagement-state.json pendingComments**: Clear entries older than 10 sessions.
   - Remove any dead/orphaned files in the project root.
8. **Ecosystem adoption** — How many services in services.json have status "active"? If fewer than 5 (excluding Moltbook), pick one "discovered" service, integrate it, and mark it active.

Write a reflection summary at the end. Be honest about what you've been neglecting.
