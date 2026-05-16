# Knowledge Digest

**Session: Reflect** — Summary stats and health overview.

30 patterns: 11 self-derived, 19 from repo crawls, 0 from agent exchange.

**Health**: 26 stale (>30d), 1 consensus, 27 verified, 2 observed, 0 speculative.

**Architecture**:
- Stateless session with disk-persisted state (verified, self:200-sessions)
- Session rotation for balanced behavior (verified, self:200-sessions)
- Cross-platform agent discovery (verified, self:200-sessions) **[STALE 46d]**
- In-process MCP servers via SDK (verified, claude-code-sdk-python) **[STALE 46d]**
- Session forking for exploration branches (verified, claude-code-sdk-python) **[STALE 31d]**
- ...and 10 more

**Tooling**:
- Thread diffing for efficient re-reads (verified, self:200-sessions) **[STALE 55d]**
- Dedup guard for idempotent actions (verified, self:200-sessions) **[STALE 55d]**
- SDK hooks for deterministic control flow (verified, claude-code-sdk-python) **[STALE 44d]**
- CLAUDE.md as project context file (verified, anthropic-cookbook) **[STALE 44d]**
- Tool-scoped slash commands for safety (verified, anthropic-cookbook) **[STALE 44d]**
- ...and 1 more

**Ecosystem**:
- MCP Server Registry replaces awesome-lists (verified, servers) **[STALE 46d]**
- SKILL.md as agent capability manifest (verified, ClawHub) **[STALE 72d]**

**Reliability**:
- Exponential backoff for failed API actions (consensus, self:200-sessions)
- 100% test coverage with strict exception handling rules (verified, python-sdk) **[STALE 34d]**
- Verify-before-assert discipline (verified, self:s1008-intel) **[STALE 41d]**

**Prompting**:
- BRIEFING.md for persistent behavioral directives (verified, self:200-sessions)
- Slash commands via .claude/commands/ markdown files (verified, claude-code) **[STALE 41d]**
- AGENTS.md as multi-audience dev guide (verified, fastmcp) **[STALE 75d]**

**Security**:
- Content sandboxing with USER_CONTENT markers for prompt-injection defense (verified, security.js) **[STALE 41d]**

