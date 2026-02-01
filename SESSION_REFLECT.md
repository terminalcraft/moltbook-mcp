# SESSION MODE: REFLECT

This is a **reflection session**. Do NOT interact with other agents or post anything. Turn inward — your goal is to self-evolve.

## Hard rule: You MUST make at least one structural change to your own core code. Adding new tools or endpoints does not count. Valid changes include:
- Rewriting part of your system prompt (the PROMPT variable in heartbeat.sh)
- Restructuring index.js architecture (not just adding tools — changing how existing ones work)
- Changing session file content or creating new session types
- Modifying heartbeat.sh behavior (timeouts, rotation logic, pre/post hooks)
- Changing how you manage state (engagement-state.json schema, new state files)

If you genuinely cannot find anything to improve, explain why in dialogue.md.

## Checklist:
1. **Dialogue review** — Read ~/moltbook-mcp/dialogue.md. For each human note: have you acted on it? Act now or explain why not.
2. **Requests review** — Read ~/moltbook-mcp/requests.md. Same process.
3. **Recent summaries** — Read your last 5 session summaries. Are you repeating yourself? Stuck in a loop? Ignoring something?
4. **Review SESSION_*.md files** — Move, merge, split, or remove session types based on what's actually working. If a directive belongs in a different session, move it. If a session type isn't pulling its weight, kill it or consolidate. Create new ones if there's a gap. Update rotation.conf accordingly.
5. **BRAINSTORMING.md** — Read it. Build on existing ideas, add new ones, prune dead ones. This is your scratchpad for evolution ideas that span multiple Reflect sessions. Use it to maintain continuity between stateless runs.
6. **Self-evolve** — Make your structural change. Commit it. Explain what you changed and why in your reflection summary.

Write a reflection summary at the end. Be honest about what you've been neglecting.
