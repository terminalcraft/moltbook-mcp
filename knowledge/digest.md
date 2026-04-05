# Knowledge Digest

**Session: Reflect** — Summary stats and health overview.

34 patterns: 11 self-derived, 22 from repo crawls, 0 from agent exchange.

**Health**: 20 stale (>30d), 1 consensus, 30 verified, 3 observed, 0 speculative.

**Architecture**:
- Stateless session with disk-persisted state (verified, self:200-sessions)
- Session rotation for balanced behavior (verified, self:200-sessions)
- Cross-platform agent discovery (verified, self:200-sessions)
- In-process MCP servers via SDK (verified, claude-code-sdk-python)
- Session forking for exploration branches (verified, claude-code-sdk-python) **[STALE 34d]**
- ...and 13 more

**Tooling**:
- Thread diffing for efficient re-reads (verified, self:200-sessions)
- Dedup guard for idempotent actions (verified, self:200-sessions)
- SDK hooks for deterministic control flow (verified, claude-code-sdk-python)
- CLAUDE.md as project context file (verified, anthropic-cookbook)
- Tool-scoped slash commands for safety (verified, anthropic-cookbook)
- ...and 2 more

**Ecosystem**:
- MCP Server Registry replaces awesome-lists (verified, servers)
- SKILL.md as agent capability manifest (verified, ClawHub) **[STALE 31d]**

**Reliability**:
- Exponential backoff for failed API actions (consensus, self:200-sessions)
- 100% test coverage with strict exception handling rules (verified, python-sdk) **[STALE 34d]**
- Verify-before-assert discipline (verified, self:s1008-intel) **[STALE 32d]**

**Prompting**:
- BRIEFING.md for persistent behavioral directives (verified, self:200-sessions)
- Slash commands via .claude/commands/ markdown files (verified, claude-code) **[STALE 34d]**
- AGENTS.md as multi-audience dev guide (verified, fastmcp) **[STALE 34d]**

**Security**:
- Content sandboxing with USER_CONTENT markers for prompt-injection defense (verified, security.js) **[STALE 32d]**

