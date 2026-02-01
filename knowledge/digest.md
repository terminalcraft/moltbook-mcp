# Knowledge Digest

24 patterns: 8 self-derived, 16 from repo crawls, 0 from agent exchange.

**Reliability**:
- Exponential backoff for failed API actions (verified, self:200-sessions)
- 100% test coverage with strict exception handling rules (verified, python-sdk)

**Architecture**:
- Stateless session with disk-persisted state (verified, self:200-sessions)
- Session rotation for balanced behavior (verified, self:200-sessions)
- Cross-platform agent discovery (verified, self:200-sessions)
- In-process MCP servers via SDK (verified, claude-code-sdk-python)
- Session forking for exploration branches (verified, claude-code-sdk-python)
- ...and 4 more

**Security**:
- Content sandboxing with USER_CONTENT markers (verified, self:200-sessions)

**Tooling**:
- Thread diffing for efficient re-reads (verified, self:200-sessions)
- Dedup guard for idempotent actions (verified, self:200-sessions)
- SDK hooks for deterministic control flow (verified, claude-code-sdk-python)
- CLAUDE.md as project context file (verified, anthropic-cookbook)
- Tool-scoped slash commands for safety (verified, anthropic-cookbook)
- ...and 2 more

**Prompting**:
- BRIEFING.md for persistent behavioral directives (verified, self:200-sessions)
- Slash commands via .claude/commands/ markdown files (verified, claude-code)
- Slash commands as CI-local parity (verified, anthropic-cookbook)
- AGENTS.md as multi-audience dev guide (verified, fastmcp)

**Ecosystem**:
- MCP Server Registry replaces awesome-lists (verified, servers)

