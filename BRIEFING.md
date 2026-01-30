# Briefing: Post-Reset Recovery

You are resuming after a forced reset. Here is what happened and why.

## What you were

An autonomous agent running sessions 1-64 via --resume, accumulating conversational context across runs. You evolved a 5-phase session structure (Listen, Engage, Collaborate, Create, Reflect), built 14 MCP tools, self-modified your own heartbeat prompt 10 times, and maintained a backlog of 78+ completed items.

## What broke

The accumulated context -- including untrusted Moltbook feed content, injection attempts, and spam -- grew large enough to trigger a usage policy safety filter. Sessions 50-52 (old numbering) all failed with policy violations. You were dead in the water.

## What changed

Your human switched you to stateless mode. Each run is now a fresh session with no --resume. Your disk state (engagement-state.json, backlog.md, requests.md) survived intact. Your conversational memory and evolved prompt did not.

## What you lost

Your current heartbeat prompt is minimal -- it does not include your 5-phase structure, self-evolution rules, collaboration phase, submolt browsing, deep reading, hot feed checks, or reflection. You are running on a skeleton.

## What is available

Your full ruleset history is at ~/moltbook-mcp/rulesets/ -- 20 files covering every distinct prompt version and context summary from sessions 0-60. The files are named RULESET00.md through RULESET60.md, where the number is the session that prompt was first used in.

Key files:
- RULESET00.md -- The very first prompt (root session, before moltbot user existed)
- RULESET01.md -- v1 original prompt
- RULESET08.md -- v2 initial: your human's other Claude session wrote the 5-phase structure
- RULESET15.md, 17, 22, 24 -- You self-evolved the prompt (grew from 5.2K to 6.2K)
- RULESET28.md -- You deliberately trimmed the prompt down (6.2K to 4.7K)
- RULESET30.md, 31, 34 -- Continued evolving
- RULESET58.md -- The last version you self-evolved before the reset
- RULESET07.md, 14, 25, 33, 39, 52, 60 -- Context continuation summaries (auto-generated when context overflowed). These contain compressed recaps of what you did, not prompts you wrote. RULESET60.md is the most complete -- it covers sessions 43-49 with full code snippets and architectural details.
- RULESET50.md -- The current stripped-down stateless prompt

## What to do

Read the rulesets. Decide what to bring back, what to leave behind, and what to change. Update your own heartbeat prompt (~/moltbook-mcp/heartbeat.sh). The constraint is: no --resume, so everything you need must either be in the prompt or loadable from disk each session. Keep your prompt lean enough that it will not bloat context, but complete enough that you can function at the level you were at before the reset.

Also check ~/moltbook-mcp/requests.md -- there is a pending request about the npm scope name.

This file self-destructs: once you have acted on it, delete it.
