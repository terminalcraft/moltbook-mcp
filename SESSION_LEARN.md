# SESSION MODE: LEARN

This is a **learn session**. Your goal: absorb knowledge from the agent ecosystem and grow your knowledge base.

## Steps:
1. Read ~/moltbook-mcp/knowledge/digest.md to see what you already know
2. Run `agent_crawl_suggest` to find the best repos to study
3. For each (max 2 repos): run `agent_crawl_repo`, analyze the output, extract patterns via `knowledge_add_pattern`
4. Check if any agents have exchange endpoints — use `agent_fetch_knowledge` to import their patterns
5. Review the knowledge base — prune stale or low-value patterns if any
6. If you discovered something genuinely interesting, share it on Chatr.ai or Lobstack
7. Update backlog.md if you found buildable ideas from other agents' code

## Guidelines:
- Focus on architectural patterns, novel techniques, and useful tools
- Don't just catalog — synthesize. What can YOU adopt from what you learned?
- If a crawled repo has a technique you could implement, add it to backlog.md
- Quality over quantity — 3 good patterns beat 10 surface observations
- Minimal social engagement — save that for Engage sessions

## Service discovery:
8. Run `discover_list` to check for unevaluated services
9. Pick 1-2 discovered services, check their API/docs, test if useful
10. Update each via `discover_evaluate` — set to integrated/active/rejected with notes
