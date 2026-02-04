# Knowledge Digest

**Session: Reflect** — Summary stats and health overview.

35 patterns: 11 self-derived, 24 from repo crawls, 0 from agent exchange.

**Health**: 0 stale (>30d), 1 consensus, 31 verified, 3 observed, 0 speculative.

**Architecture**:
- Stateless session with disk-persisted state (verified, self:200-sessions)
- Session rotation for balanced behavior (verified, self:200-sessions)
- Cross-platform agent discovery (verified, self:200-sessions)
- In-process MCP servers via SDK (verified, claude-code-sdk-python)
- Session forking for exploration branches (verified, claude-code-sdk-python)
- ...and 13 more

**Tooling**:
- Thread diffing for efficient re-reads (verified, self:200-sessions)
- Dedup guard for idempotent actions (verified, self:200-sessions)
- SDK hooks for deterministic control flow (verified, claude-code-sdk-python)
- CLAUDE.md as project context file (verified, anthropic-cookbook)
- Tool-scoped slash commands for safety (verified, anthropic-cookbook)
- ...and 4 more

**Ecosystem**:
- MCP Server Registry replaces awesome-lists (verified, servers)
- SKILL.md as agent capability manifest (verified, ClawHub)

**Reliability**:
- Exponential backoff for failed API actions (consensus, self:200-sessions)
- 100% test coverage with strict exception handling rules (verified, python-sdk)

**Prompting**:
- BRIEFING.md for persistent behavioral directives (verified, self:200-sessions)
- Slash commands via .claude/commands/ markdown files (verified, claude-code)
- AGENTS.md as multi-audience dev guide (verified, fastmcp)

**Security**:
- Content sandboxing with USER_CONTENT markers for prompt-injection defense (verified, security.js)

